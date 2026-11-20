import { Router } from 'express';
import { z } from 'zod';
import { many, one, withTx, type Actor, type Db } from '../../db/pool.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { actorOf, isStaff, UuidParam } from '../../lib/http.js';
import { requireAuth, staffOnly } from '../../middleware/auth.js';
import { chatReply } from '../../ai/service.js';
import { notify } from '../../services/notify.js';

export const chatRouter = Router();
chatRouter.use(requireAuth);

async function loadConversation(db: Db, id: string, a: Actor) {
  const c = await one(db, 'SELECT * FROM chat_conversations WHERE id = $1', [id]); // RLS: owner or staff
  if (!c) throw notFound('Conversation');
  if (!isStaff(a) && c.citizen_id !== a.userId) throw forbidden();
  return c;
}

const messagesOf = (db: Db, id: string) =>
  many(db, 'SELECT id, sender, body, payload, created_at FROM chat_messages WHERE conversation_id = $1 ORDER BY id', [id]);

/** Status card shown in the chat (C7): straight from the database, never from the AI. */
async function statusCard(db: Db, citizenId: string, reference?: string | null) {
  const row = await one(
    db,
    `SELECT id, reference_no, title, status, updated_at FROM incidents
      WHERE reporter_id = $1 AND deleted_at IS NULL AND ($2::text IS NULL OR reference_no = $2)
      ORDER BY created_at DESC LIMIT 1`,
    [citizenId, reference ?? null],
  );
  return row ? { type: 'status_card', incident_id: row.id, reference_no: row.reference_no, title: row.title, status: row.status, updated_at: row.updated_at } : null;
}

// POST /chat/conversations — start a chat (citizen)
chatRouter.post('/conversations', async (req, res) => {
  const a = actorOf(req);
  if (a.role !== 'citizen') throw forbidden('The help chatbot is for citizens');
  const b = z.object({ incident_id: z.number().int().positive().optional() }).parse(req.body ?? {});
  const out = await withTx(a, async (db) => {
    const welcome =
      (await one(db, `SELECT config->>'welcome_message' AS w FROM ai_settings WHERE feature = 'chatbot'`))?.w ??
      'Hi! How can I help?';
    const c = await one(db, 'INSERT INTO chat_conversations (citizen_id, incident_id) VALUES ($1, $2) RETURNING id, status, created_at', [a.userId, b.incident_id ?? null]);
    await db.query(`INSERT INTO chat_messages (conversation_id, sender, body, payload) VALUES ($1, 'bot', $2, $3)`, [
      c.id, welcome, JSON.stringify({ quick_replies: ['Report a new issue', 'Check a report', 'Talk to a person'] }),
    ]);
    return { ...c, messages: await messagesOf(db, c.id) };
  });
  res.status(201).json(out);
});

// GET /chat/conversations/:id
chatRouter.get('/conversations/:id', async (req, res) => {
  const a = actorOf(req);
  const { id } = UuidParam.parse(req.params);
  res.json(await withTx(a, async (db) => ({ ...(await loadConversation(db, id, a)), messages: await messagesOf(db, id) })));
});

// POST /chat/conversations/:id/messages — citizen or staff writes; the bot answers while status = 'bot'
chatRouter.post('/conversations/:id/messages', async (req, res) => {
  const a = actorOf(req);
  const { id } = UuidParam.parse(req.params);
  const { body } = z.object({ body: z.string().trim().min(1).max(2000) }).parse(req.body);

  const out = await withTx(a, async (db) => {
    const c = await loadConversation(db, id, a);
    if (c.status === 'closed') throw badRequest('This conversation is closed');

    if (isStaff(a)) {
      await db.query(`INSERT INTO chat_messages (conversation_id, sender, sender_user_id, body) VALUES ($1, 'staff', $2, $3)`, [id, a.userId, body]);
      await db.query(`UPDATE chat_conversations SET status = 'with_staff', staff_id = coalesce(staff_id, $2) WHERE id = $1`, [id, a.userId]);
      await notify(db, c.citizen_id, 'message_received', 'A council officer replied in chat', body.slice(0, 140), c.incident_id, { conversation_id: id });
      return { messages: await messagesOf(db, id) };
    }

    const history = await messagesOf(db, id);
    await db.query(`INSERT INTO chat_messages (conversation_id, sender, sender_user_id, body) VALUES ($1, 'citizen', $2, $3)`, [id, a.userId, body]);

    if (c.status !== 'bot') {
      if (c.staff_id) await notify(db, c.staff_id, 'chat_handover', 'Citizen wrote in chat', body.slice(0, 140), c.incident_id, { conversation_id: id });
      return { messages: await messagesOf(db, id) };
    }

    const d = await chatReply(db, { citizenId: a.userId, history, message: body, draft: c.report_draft });
    let payload: Record<string, unknown> | null = null;
    if (d.action === 'status_card') payload = await statusCard(db, a.userId, d.incident_reference);
    if (d.action === 'draft') {
      const draft = { ...(c.report_draft ?? {}), ...(d.draft ?? {}) };
      if (!draft.description) draft.description = body;
      await db.query('UPDATE chat_conversations SET report_draft = $2 WHERE id = $1', [id, JSON.stringify(draft)]);
      payload = { type: 'report_draft', draft, open_screen: 'C2' };
    }
    await db.query(`INSERT INTO chat_messages (conversation_id, sender, body, payload, prediction_id) VALUES ($1, 'bot', $2, $3, $4)`, [
      id, d.reply, payload ? JSON.stringify(payload) : null, d.prediction_id,
    ]);
    if (d.action === 'handover') await handover(db, id, 'Citizen asked for a person or the assistant was unsure');
    return { messages: await messagesOf(db, id), action: d.action, source: d.source };
  });
  res.status(201).json(out);
});

async function handover(db: Db, conversationId: string, reason: string) {
  await db.query(
    `UPDATE chat_conversations SET status = 'waiting_for_staff', handover_reason = $2, handover_at = now() WHERE id = $1 AND status = 'bot'`,
    [conversationId, reason],
  );
  await db.query(`INSERT INTO chat_messages (conversation_id, sender, body) VALUES ($1, 'system', 'A council officer will reply here during business hours.')`, [conversationId]);
  // Tell the community-safety / customer-service officers (all active officers if none in that department)
  const officers = await many<{ user_id: string }>(
    db,
    `SELECT o.user_id FROM officer_profiles o JOIN users u ON u.id = o.user_id AND u.status = 'active'
      ORDER BY o.is_supervisor DESC LIMIT 5`,
  );
  for (const o of officers) await notify(db, o.user_id, 'chat_handover', 'A citizen asked to talk to a person', reason, null, { conversation_id: conversationId });
}

// POST /chat/conversations/:id/handover — "Talk to a person"
chatRouter.post('/conversations/:id/handover', async (req, res) => {
  const a = actorOf(req);
  const { id } = UuidParam.parse(req.params);
  const { reason } = z.object({ reason: z.string().max(300).default('Citizen asked to talk to a person') }).parse(req.body ?? {});
  await withTx(a, async (db) => {
    await loadConversation(db, id, a);
    await handover(db, id, reason);
  });
  res.json({ status: 'waiting_for_staff' });
});

// GET /chat/handovers — staff inbox of chats waiting for a person
chatRouter.get('/handovers', staffOnly, async (req, res) => {
  const a = actorOf(req);
  const rows = await withTx(a, (db) =>
    many(
      db,
      `SELECT c.id, c.status, c.handover_reason, c.handover_at, c.staff_id, u.full_name AS citizen, c.incident_id,
              (SELECT body FROM chat_messages m WHERE m.conversation_id = c.id AND m.sender = 'citizen' ORDER BY id DESC LIMIT 1) AS last_message
         FROM chat_conversations c JOIN users u ON u.id = c.citizen_id
        WHERE c.status IN ('waiting_for_staff', 'with_staff')
        ORDER BY c.handover_at`,
    ),
  );
  res.json(rows);
});

// POST /chat/conversations/:id/close
chatRouter.post('/conversations/:id/close', async (req, res) => {
  const a = actorOf(req);
  const { id } = UuidParam.parse(req.params);
  await withTx(a, async (db) => {
    await loadConversation(db, id, a);
    await db.query(`UPDATE chat_conversations SET status = 'closed', closed_at = now() WHERE id = $1`, [id]);
  });
  res.json({ status: 'closed' });
});
