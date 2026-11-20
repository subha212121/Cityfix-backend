import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { many, one, type Db } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { getProvider, redact, type ChatTurn } from './provider.js';
import { classifyByKeywords, extractiveSummary, ruleBasedChat, type CategoryOption, type Priority } from './fallback.js';

type Feature = 'categorize' | 'prioritize' | 'incident_summary' | 'chatbot' | 'monthly_summary';
const PROMPT_VERSION = 'v1';

async function settings(db: Db, feature: Feature) {
  return (
    (await one<{ is_enabled: boolean; auto_apply_threshold: number | null; config: any }>(
      db,
      'SELECT is_enabled, auto_apply_threshold, config FROM ai_settings WHERE feature = $1',
      [feature],
    )) ?? { is_enabled: false, auto_apply_threshold: null, config: {} }
  );
}

export async function categoryOptions(db: Db): Promise<CategoryOption[]> {
  return many<CategoryOption>(
    db,
    `SELECT c.id, c.name, p.name AS parent_name,
            coalesce(array_agg(k.keyword::text) FILTER (WHERE k.keyword IS NOT NULL), '{}') AS keywords
       FROM categories c
       LEFT JOIN categories p ON p.id = c.parent_id
       LEFT JOIN category_keywords k ON k.category_id = c.id
      WHERE c.is_active
      GROUP BY c.id, p.name, p.sort_order
      ORDER BY coalesce(p.sort_order, c.sort_order), c.parent_id NULLS FIRST, c.sort_order`,
  );
}

const hash = (s: string) => crypto.createHash('sha256').update(s).digest();

/** Runs the provider with a timeout; returns null + status on any failure. */
async function callJson(messages: ChatTurn[]) {
  const provider = getProvider();
  if (!provider) return { status: 'disabled' as const, result: null, error: 'AI provider not configured' };
  const started = Date.now();
  try {
    const result = await provider.json(messages, config.AI_TIMEOUT_MS);
    return { status: 'success' as const, result, latency: Date.now() - started };
  } catch (err: any) {
    const timeout = /timed? ?out|abort/i.test(String(err?.message ?? err));
    logger.warn({ err: err?.message }, 'AI call failed');
    return { status: timeout ? ('timeout' as const) : ('failed' as const), result: null, error: String(err?.message ?? err), latency: Date.now() - started };
  }
}

// ---------------------------------------------------------------------------
// 6.1 + 6.2  Category and priority suggestion
// ---------------------------------------------------------------------------
const ClassifyOut = z.object({
  category_id: z.number().int(),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  reason: z.string().min(3).max(300),
  confidence: z.number().min(0).max(1),
});

export interface Suggestion {
  prediction_id: number;
  category_id: number | null;
  priority: Priority;
  reason: string;
  confidence: number;
  source: 'ai' | 'fallback';
  ai_available: boolean;
}

export async function suggestClassification(db: Db, input: { title?: string; description: string; incidentId?: number }): Promise<Suggestion> {
  const [cat, pri] = await Promise.all([settings(db, 'categorize'), settings(db, 'prioritize')]);
  const cats = await categoryOptions(db);
  const text = redact(`${input.title ?? ''}\n${input.description}`.trim());
  // the title is the citizen's own summary, so it counts double in the keyword fallback
  const fallback = classifyByKeywords(`${redact(input.title ?? '')} ${text}`, cats);

  let out = fallback;
  let source: 'ai' | 'fallback' = 'fallback';
  let run: { status: 'success' | 'failed' | 'timeout' | 'disabled'; latency?: number; error?: string; model?: string; tokensIn?: number; tokensOut?: number } = {
    status: 'disabled',
    error: 'AI categorisation is switched off',
  };

  if (cat.is_enabled || pri.is_enabled) {
    const list = cats.map((c) => `${c.id}: ${c.parent_name ? `${c.parent_name} > ` : ''}${c.name}`).join('\n');
    const call = await callJson([
      {
        role: 'system',
        content:
          'You triage incident reports for a local council. Pick the single best category id from the list ' +
          '(prefer a specific subcategory). Priority: critical = immediate danger to life or major disruption ' +
          '(live wires, flooding into homes, traffic signals out at a busy intersection); high = a safety risk or ' +
          'blocked access; medium = needs repair but not dangerous; low = cosmetic or minor inconvenience. ' +
          'Reply as JSON: {"category_id": number, "priority": "low|medium|high|critical", ' +
          '"reason": "one plain-English sentence, max 25 words", "confidence": 0..1}.\n\nCategories:\n' + list,
      },
      { role: 'user', content: text },
    ]);
    run = { status: call.status, latency: call.latency, error: call.error, model: call.result?.model, tokensIn: call.result?.tokensIn, tokensOut: call.result?.tokensOut };
    if (call.result) {
      const parsed = ClassifyOut.safeParse(call.result.data);
      if (parsed.success && cats.some((c) => c.id === parsed.data.category_id)) {
        out = {
          category_id: cat.is_enabled ? parsed.data.category_id : fallback.category_id,
          priority: pri.is_enabled ? parsed.data.priority : 'medium',
          reason: parsed.data.reason,
          confidence: parsed.data.confidence,
        };
        source = 'ai';
      } else {
        run = { ...run, status: 'failed', error: 'AI returned an invalid answer' };
      }
    }
  }

  const row = await one<{ id: number }>(
    db,
    `INSERT INTO ai_predictions (feature, incident_id, model_name, prompt_version, input_hash, output,
                                 suggested_category_id, suggested_priority, reason, confidence,
                                 run_status, error_message, latency_ms, tokens_in, tokens_out)
     VALUES ('categorize', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
    [
      input.incidentId ?? null, run.model ?? (source === 'fallback' ? 'keyword-fallback' : null), PROMPT_VERSION, hash(text),
      JSON.stringify({ ...out, source }), out.category_id, out.priority, out.reason, out.confidence,
      run.status, run.error ?? null, run.latency ?? null, run.tokensIn ?? null, run.tokensOut ?? null,
    ],
  );
  return { prediction_id: row!.id, ...out, source, ai_available: run.status === 'success' };
}

// ---------------------------------------------------------------------------
// 6.3  Summary of a long report (or of all merged duplicate reports)
// ---------------------------------------------------------------------------
export async function summariseIncident(db: Db, incidentId: number) {
  const s = await settings(db, 'incident_summary');
  const reports = await many<{ description: string }>(
    db,
    `SELECT description FROM incidents WHERE id = $1
     UNION ALL
     SELECT description FROM incidents WHERE merged_into_id = $1`,
    [incidentId],
  );
  if (!reports.length) return null;
  const texts = reports.map((r) => redact(r.description));
  let summary = extractiveSummary(texts);
  let status: 'success' | 'failed' | 'timeout' | 'disabled' = 'disabled';
  let model = 'extractive-fallback';
  let latency: number | undefined;

  if (s.is_enabled) {
    const call = await callJson([
      {
        role: 'system',
        content:
          'Summarise citizen reports about one council incident for the officer handling it. ' +
          'Max 60 words, plain English, facts only: what, where, how bad, anything time-critical. ' +
          'If several reports, say how many and note any differences. Reply as JSON {"summary": string}.',
      },
      { role: 'user', content: texts.map((t, i) => `Report ${i + 1}: ${t}`).join('\n\n') },
    ]);
    status = call.status;
    latency = call.latency;
    const parsed = z.object({ summary: z.string().min(5).max(800) }).safeParse(call.result?.data);
    if (parsed.success) {
      summary = parsed.data.summary;
      model = call.result!.model;
    } else if (call.result) status = 'failed';
  }

  await db.query(
    `INSERT INTO ai_predictions (feature, incident_id, model_name, prompt_version, output, run_status, latency_ms, decision)
     VALUES ('incident_summary', $1, $2, $3, $4, $5, $6, 'auto_applied')`,
    [incidentId, model, PROMPT_VERSION, JSON.stringify({ summary, reports: texts.length }), status, latency ?? null],
  );
  await db.query('UPDATE incidents SET ai_summary = $2, ai_summary_updated_at = now() WHERE id = $1', [incidentId, summary]);
  return summary;
}

// ---------------------------------------------------------------------------
// 6.4  Chatbot
// ---------------------------------------------------------------------------
const ChatOut = z.object({
  reply: z.string().min(1).max(1200),
  action: z.enum(['none', 'status_card', 'draft', 'handover']).default('none'),
  incident_reference: z.string().optional().nullable(),
  draft: z
    .object({ title: z.string().max(120).optional(), description: z.string().max(4000).optional(), category_id: z.number().int().optional() })
    .optional()
    .nullable(),
});
export type ChatDecision = z.infer<typeof ChatOut>;

export async function chatReply(
  db: Db,
  ctx: { citizenId: string; history: { sender: string; body: string }[]; message: string; draft: any },
): Promise<ChatDecision & { prediction_id: number; source: 'ai' | 'fallback' }> {
  const s = await settings(db, 'chatbot');
  const faq = await many<{ question: string; answer: string }>(db, 'SELECT question, answer FROM faq_articles WHERE is_published ORDER BY sort_order');
  const mine = await many(
    db,
    `SELECT reference_no, title, status, updated_at::date AS updated FROM incidents
      WHERE reporter_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 5`,
    [ctx.citizenId],
  );

  let decision: ChatDecision = ruleBasedChat(ctx.message, faq);
  let source: 'ai' | 'fallback' = 'fallback';
  let status: 'success' | 'failed' | 'timeout' | 'disabled' = 'disabled';
  let latency: number | undefined;

  if (s.is_enabled) {
    const cats = await categoryOptions(db);
    const call = await callJson([
      {
        role: 'system',
        content:
          `You are the CityFix help assistant for a local council. ${s.config?.welcome_message ?? ''}\n` +
          'Answer only about council services, how reporting works, and the citizen\'s own reports. Be brief (max 80 words). ' +
          'Never invent report numbers or statuses: use only the list below. If the citizen wants a person, or you are unsure, ' +
          'use action "handover". To show a report status use action "status_card" with its incident_reference. ' +
          'To help lodge a report, collect what and where, then use action "draft" with draft {title, description, category_id}. ' +
          'Reply as JSON {"reply", "action", "incident_reference", "draft"}.\n\n' +
          `FAQ:\n${faq.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join('\n')}\n\n` +
          `Citizen's recent reports:\n${mine.map((r: any) => `${r.reference_no} | ${r.title} | ${r.status} | updated ${r.updated}`).join('\n') || 'none'}\n\n` +
          `Categories:\n${cats.map((c) => `${c.id}: ${c.parent_name ? c.parent_name + ' > ' : ''}${c.name}`).join('\n')}\n\n` +
          `Current report draft: ${JSON.stringify(ctx.draft ?? null)}`,
      },
      ...ctx.history.slice(-10).map((h) => ({ role: (h.sender === 'citizen' ? 'user' : 'assistant') as 'user' | 'assistant', content: redact(h.body) })),
      { role: 'user', content: redact(ctx.message) },
    ]);
    status = call.status;
    latency = call.latency;
    const parsed = ChatOut.safeParse(call.result?.data);
    if (parsed.success) {
      decision = parsed.data;
      source = 'ai';
    } else if (call.result) status = 'failed';
  }

  const row = await one<{ id: number }>(
    db,
    `INSERT INTO ai_predictions (feature, model_name, prompt_version, input_hash, output, run_status, latency_ms, decision)
     VALUES ('chatbot', $1, $2, $3, $4, $5, $6, 'auto_applied') RETURNING id`,
    [source === 'ai' ? getProvider()?.model : 'rule-fallback', PROMPT_VERSION, hash(ctx.message), JSON.stringify(decision), status, latency ?? null],
  );
  return { ...decision, prediction_id: row!.id, source };
}

// ---------------------------------------------------------------------------
// Admin dashboard: monthly summary in plain words
// ---------------------------------------------------------------------------
export async function monthlySummary(db: Db, periodStart: string, periodEnd: string) {
  const s = await settings(db, 'monthly_summary');
  const stats = await one(
    db,
    `SELECT count(*) AS received,
            count(*) FILTER (WHERE status IN ('resolved','closed') AND closure_reason IS DISTINCT FROM 'duplicate') AS resolved,
            round(avg(extract(epoch FROM resolved_at - created_at) / 86400) FILTER (WHERE resolved_at IS NOT NULL)::numeric, 1) AS avg_days,
            count(*) FILTER (WHERE resolved_at > sla_due_at OR (resolved_at IS NULL AND sla_due_at < now())) AS past_sla
       FROM incidents WHERE created_at >= $1 AND created_at < $2 AND deleted_at IS NULL`,
    [periodStart, periodEnd],
  );
  const top = await many(
    db,
    `SELECT coalesce(p.name, c.name) AS category, count(*) AS n
       FROM incidents i JOIN categories c ON c.id = i.category_id LEFT JOIN categories p ON p.id = c.parent_id
      WHERE i.created_at >= $1 AND i.created_at < $2 GROUP BY 1 ORDER BY 2 DESC LIMIT 3`,
    [periodStart, periodEnd],
  );
  const wards = await many(
    db,
    `SELECT w.name AS ward, count(*) AS n FROM incidents i JOIN wards w ON w.id = i.ward_id
      WHERE i.created_at >= $1 AND i.created_at < $2 GROUP BY 1 ORDER BY 2 DESC LIMIT 2`,
    [periodStart, periodEnd],
  );
  let body =
    `${stats.received} reports received, ${stats.resolved} resolved` +
    (stats.avg_days != null ? `, average ${stats.avg_days} days to resolve` : '') +
    `. ${stats.past_sla} went past their target time.` +
    (top.length ? ` Most reported: ${top.map((t: any) => `${t.category} (${t.n})`).join(', ')}.` : '') +
    (wards.length ? ` Busiest wards: ${wards.map((w: any) => `${w.ward} (${w.n})`).join(', ')}.` : '');
  let status: 'success' | 'failed' | 'timeout' | 'disabled' = 'disabled';

  if (s.is_enabled) {
    const call = await callJson([
      { role: 'system', content: 'Write a 3-sentence plain-English summary of this month for council managers. Use only the numbers given. Reply as JSON {"summary": string}.' },
      { role: 'user', content: JSON.stringify({ period: [periodStart, periodEnd], stats, top_categories: top, busiest_wards: wards }) },
    ]);
    status = call.status;
    const parsed = z.object({ summary: z.string().min(10).max(1500) }).safeParse(call.result?.data);
    if (parsed.success) body = parsed.data.summary;
  }

  const pred = await one<{ id: number }>(
    db,
    `INSERT INTO ai_predictions (feature, model_name, output, run_status, decision)
     VALUES ('monthly_summary', $1, $2, $3, 'auto_applied') RETURNING id`,
    [status === 'success' ? getProvider()?.model : 'template-fallback', JSON.stringify({ body }), status],
  );
  await db.query(
    `INSERT INTO analytics_summaries (period_start, period_end, body, prediction_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (period_start, period_end, coalesce(ward_id, 0)) DO UPDATE SET body = EXCLUDED.body, prediction_id = EXCLUDED.prediction_id`,
    [periodStart, periodEnd, body, pred!.id],
  );
  return body;
}
