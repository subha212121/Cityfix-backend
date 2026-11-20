import { Router } from 'express';
import { z } from 'zod';
import { many, one, withTx } from '../../db/pool.js';
import { actorOf, IdParam, Page, pageClause, paged } from '../../lib/http.js';
import { notFound } from '../../lib/errors.js';
import { requireAuth } from '../../middleware/auth.js';

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

// GET /notifications (C6, O5)
notificationsRouter.get('/', async (req, res) => {
  const a = actorOf(req);
  const q = Page.extend({ unread_only: z.enum(['true', 'false']).optional(), event: z.string().optional() }).parse(req.query);
  const { limit, offset } = pageClause(q);
  const rows = await withTx(a, (db) =>
    many(
      db,
      `SELECT n.id, n.event, n.title, n.body, n.data, n.read_at, n.created_at, n.incident_id, i.reference_no,
              count(*) OVER () AS total_count
         FROM notifications n LEFT JOIN incidents i ON i.id = n.incident_id
        WHERE n.user_id = $1 AND ($2::boolean IS NOT TRUE OR n.read_at IS NULL)
          AND ($3::notification_event IS NULL OR n.event = $3)
        ORDER BY n.created_at DESC LIMIT $4 OFFSET $5`,
      [a.userId, q.unread_only === 'true', q.event ?? null, limit, offset],
    ),
  );
  res.json(paged(rows, q));
});

notificationsRouter.get('/unread-count', async (req, res) => {
  const a = actorOf(req);
  const r = await withTx(a, (db) => one(db, 'SELECT count(*) AS unread FROM notifications WHERE user_id = $1 AND read_at IS NULL', [a.userId]));
  res.json(r);
});

notificationsRouter.post('/read-all', async (req, res) => {
  const a = actorOf(req);
  const r = await withTx(a, (db) => db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [a.userId]));
  res.json({ marked: r.rowCount });
});

notificationsRouter.post('/:id/read', async (req, res) => {
  const a = actorOf(req);
  const { id } = IdParam.parse(req.params);
  const r = await withTx(a, (db) => one(db, 'UPDATE notifications SET read_at = coalesce(read_at, now()) WHERE id = $1 AND user_id = $2 RETURNING id, read_at', [id, a.userId]));
  if (!r) throw notFound('Notification');
  res.json(r);
});
