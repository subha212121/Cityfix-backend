/**
 * Rule-based fallback used when AI is switched off, not configured, times out
 * or returns something invalid (FR-30). Deterministic, so it also makes tests
 * and demos repeatable.
 */
export type Priority = 'low' | 'medium' | 'high' | 'critical';

export interface CategoryOption {
  id: number;
  name: string;
  parent_name: string | null;
  keywords: string[];
}

const PRIORITY_WORDS: Record<Exclude<Priority, 'medium'>, string[]> = {
  critical: ['live wire', 'exposed wire', 'fire', 'gas leak', 'sinkhole', 'collapsed', 'injured', 'injury',
    'flooding into', 'house flooding', 'signals out', 'traffic lights out', 'all lanes', 'chemical'],
  high: ['dangerous', 'unsafe', 'hazard', 'swerving', 'accident', 'not working', 'burst', 'flood', 'needle',
    'school', 'blocking', 'blocked', 'traffic light', 'signal', 'fallen tree', 'busy road', 'dark', 'congestion'],
  low: ['graffiti', 'noise', 'missed collection', 'bench', 'faded', 'cosmetic', 'minor', 'small', 'tag'],
};

export function classifyByKeywords(text: string, categories: CategoryOption[]) {
  const t = ` ${text.toLowerCase()} `;
  let best: { cat: CategoryOption; hits: string[] } | null = null;
  for (const cat of categories) {
    const hits = cat.keywords.flatMap((k) => {
      const n = t.split(k.toLowerCase()).length - 1; // occurrences, so a repeated title word counts more
      return Array(Math.min(n, 3)).fill(k);
    });
    // a subcategory beats its parent when hits tie
    if (hits.length && (!best || hits.length > best.hits.length || (hits.length === best.hits.length && cat.parent_name && !best.cat.parent_name))) {
      best = { cat, hits };
    }
  }

  let priority: Priority = 'medium';
  let pWords: string[] = [];
  for (const level of ['critical', 'high', 'low'] as const) {
    const found = PRIORITY_WORDS[level].filter((w) => t.includes(w));
    if (found.length) {
      priority = level;
      pWords = found;
      break;
    }
  }

  const reasonParts: string[] = [];
  if (best) reasonParts.push(`mentions ${best.hits.slice(0, 3).map((h) => `"${h}"`).join(', ')}`);
  if (pWords.length) reasonParts.push(`${priority} because it mentions "${pWords[0]}"`);
  return {
    category_id: best?.cat.id ?? null,
    priority,
    reason: reasonParts.length ? `Keyword match: ${reasonParts.join('; ')}.` : 'No clear keywords; please choose a category.',
    confidence: best ? Math.min(0.85, 0.45 + 0.15 * best.hits.length) : 0,
  };
}

/** First sentences of the report, cut to ~280 characters. */
export function extractiveSummary(texts: string[]) {
  const main = texts[0] ?? '';
  const sentences = main.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]?/g) ?? [main];
  let out = '';
  for (const s of sentences) {
    if ((out + s).length > 280) break;
    out += s;
  }
  out = (out || main.slice(0, 277) + '...').trim();
  if (texts.length > 1) out += ` (${texts.length} citizen reports about this issue.)`;
  return out;
}

export interface FaqItem {
  question: string;
  answer: string;
}

/** Simple intent rules for the chatbot when AI is unavailable. */
export function ruleBasedChat(message: string, faq: FaqItem[]) {
  const m = message.toLowerCase();
  const ref = message.match(/INC-\d{4}-\d{5}/i)?.[0]?.toUpperCase();
  if (/\b(person|human|someone|staff|officer|agent)\b/.test(m)) {
    return { reply: 'I will pass you to a council officer. They will reply here.', action: 'handover' as const };
  }
  if (ref || /\b(status|update|progress|my report|when will)\b/.test(m)) {
    return { reply: ref ? `Here is the latest on ${ref}.` : 'Here is the latest on your most recent report.', action: 'status_card' as const, incident_reference: ref };
  }
  // A question that matches an FAQ well is answered from the FAQ first
  const words = m.split(/\W+/).filter((w) => w.length > 3);
  const scored = faq
    .map((f) => ({ f, score: words.filter((w) => f.question.toLowerCase().includes(w)).length }))
    .sort((x, y) => y.score - x.score);
  const isQuestion = /\?|^(can|how|what|who|when|why|where|do|does|is|are)\b/.test(m.trim());
  if (isQuestion && scored[0]?.score >= 2) return { reply: scored[0].f.answer, action: 'none' as const };
  if (/\b(report|lodge|submit|new issue)\b/.test(m) && !/\bhow (long|do statuses)\b/.test(m)) {
    return {
      reply: 'I can help you lodge a report. Tell me what the problem is and where it is, and I will fill in the report form for you to check.',
      action: 'draft' as const,
    };
  }
  if (scored[0]?.score >= 1) return { reply: scored[0].f.answer, action: 'none' as const };
  return {
    reply: 'I can explain how reporting works, help you lodge a report, or check a report\'s status. You can also ask to talk to a person.',
    action: 'none' as const,
  };
}
