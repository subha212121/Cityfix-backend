import { Router } from 'express';
import { z } from 'zod';
import { many, one, withTx } from '../../db/pool.js';
import { actorOf } from '../../lib/http.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { hashPassword, PASSWORD_RULE, verifyPassword } from '../../lib/security.js';
import { requireAuth } from '../../middleware/auth.js';

export const meRouter = Router();
meRouter.use(requireAuth);

const EVENTS = [
  'report_received', 'status_changed', 'message_received', 'rating_requested', 'incident_assigned',
  'incident_reassigned', 'incident_reopened', 'sla_due_soon', 'sla_breached', 'rating_received',
  'chat_handover', 'daily_queue_summary', 'export_ready',
] as const;

// GET /me — profile for C8 / O6 (role-specific fields from the profile tables)
meRouter.get('/', async (req, res) => {
  const a = actorOf(req);
  const me = await withTx(a, (db) =>
    one(
      db,
      `SELECT v.*, d.name AS department, t.name AS team,
              CASE WHEN c.home_location IS NULL THEN NULL
                   ELSE json_build_object('lat', ST_Y(c.home_location::geometry), 'lng', ST_X(c.home_location::geometry)) END AS home_location
         FROM v_users v
         LEFT JOIN departments d ON d.id = v.department_id
         LEFT JOIN teams t ON t.id = v.team_id
         LEFT JOIN citizen_profiles c ON c.user_id = v.id
        WHERE v.id = $1`,
      [a.userId],
    ),
  );
  if (!me) throw notFound('User');
  res.json(me);
});

// PATCH /me
meRouter.patch('/', async (req, res) => {
  const a = actorOf(req);
  const b = z
    .object({
      full_name: z.string().trim().min(2).max(120).optional(),
      phone: z.string().trim().max(30).nullable().optional(),
      preferred_language: z.string().min(2).max(10).optional(),
      home_suburb: z.string().trim().max(80).nullable().optional(),
      home_lat: z.number().min(-90).max(90).optional(),
      home_lng: z.number().min(-180).max(180).optional(),
      default_anonymous: z.boolean().optional(),
    })
    .parse(req.body);
  await withTx(a, async (db) => {
    await db.query(
      `UPDATE users SET full_name = coalesce($2, full_name), phone = CASE WHEN $3::boolean THEN $4 ELSE phone END,
              preferred_language = coalesce($5, preferred_language) WHERE id = $1`,
      [a.userId, b.full_name ?? null, b.phone !== undefined, b.phone ?? null, b.preferred_language ?? null],
    );
    if (a.role === 'citizen') {
      await db.query(
        `UPDATE citizen_profiles SET
            home_suburb = CASE WHEN $2::boolean THEN $3 ELSE home_suburb END,
            home_location = CASE WHEN $4::float8 IS NOT NULL AND $5::float8 IS NOT NULL
                                 THEN ST_MakePoint($5, $4)::geography ELSE home_location END,
            default_anonymous = coalesce($6, default_anonymous)
          WHERE user_id = $1`,
        [a.userId, b.home_suburb !== undefined, b.home_suburb ?? null, b.home_lat ?? null, b.home_lng ?? null, b.default_anonymous ?? null],
      );
    }
  });
  res.json({ updated: true });
});

// POST /me/change-password (O6)
meRouter.post('/change-password', async (req, res) => {
  const a = actorOf(req);
  const b = z.object({ current_password: z.string(), new_password: z.string().regex(PASSWORD_RULE, 'Use at least 8 characters with a letter and a number') }).parse(req.body);
  await withTx(a, async (db) => {
    const u = await one<{ password_hash: string }>(db, 'SELECT password_hash FROM users WHERE id = $1', [a.userId]);
    if (!u || !(await verifyPassword(u.password_hash, b.current_password))) throw badRequest('Current password is incorrect');
    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [a.userId, await hashPassword(b.new_password)]);
    await db.query(`INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES ($1, 'password_changed', 'user', $2)`, [a.userId, String(a.userId)]);
  });
  res.json({ changed: true });
});

// GET /me/notification-preferences — every event with in_app/email/push (defaults on)
meRouter.get('/notification-preferences', async (req, res) => {
  const a = actorOf(req);
  const rows = await withTx(a, (db) =>
    many(
      db,
      `SELECT e.event, coalesce(p.in_app, true) AS in_app, coalesce(p.email, true) AS email, coalesce(p.push, true) AS push
         FROM unnest(enum_range(NULL::notification_event)) AS e(event)
         LEFT JOIN notification_preferences p ON p.user_id = $1 AND p.event = e.event`,
      [a.userId],
    ),
  );
  res.json(rows);
});

// PUT /me/notification-preferences
meRouter.put('/notification-preferences', async (req, res) => {
  const a = actorOf(req);
  const prefs = z
    .array(z.object({ event: z.enum(EVENTS), in_app: z.boolean(), email: z.boolean(), push: z.boolean() }))
    .max(EVENTS.length)
    .parse(req.body);
  await withTx(a, async (db) => {
    for (const p of prefs) {
      await db.query(
        `INSERT INTO notification_preferences (user_id, event, in_app, email, push) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, event) DO UPDATE SET in_app = EXCLUDED.in_app, email = EXCLUDED.email, push = EXCLUDED.push`,
        [a.userId, p.event, p.in_app, p.email, p.push],
      );
    }
  });
  res.json({ updated: prefs.length });
});

// POST /me/push-tokens · DELETE /me/push-tokens/:token
meRouter.post('/push-tokens', async (req, res) => {
  const a = actorOf(req);
  const b = z.object({ platform: z.enum(['ios', 'android', 'web']), token: z.string().min(10).max(500) }).parse(req.body);
  await withTx(a, (db) =>
    db.query(
      `INSERT INTO device_push_tokens (user_id, platform, token) VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, last_seen_at = now()`,
      [a.userId, b.platform, b.token],
    ),
  );
  res.status(201).json({ registered: true });
});
meRouter.delete('/push-tokens/:token', async (req, res) => {
  const a = actorOf(req);
  await withTx(a, (db) => db.query('DELETE FROM device_push_tokens WHERE user_id = $1 AND token = $2', [a.userId, req.params.token]));
  res.status(204).end();
});

// POST /me/feedback — "Send feedback about the app" (C8)
meRouter.post('/feedback', async (req, res) => {
  const a = actorOf(req);
  const b = z.object({ body: z.string().trim().min(1).max(2000), app_version: z.string().max(40).optional(), platform: z.string().max(40).optional() }).parse(req.body);
  const row = await withTx(a, (db) =>
    one(db, 'INSERT INTO app_feedback (user_id, body, app_version, platform) VALUES ($1, $2, $3, $4) RETURNING id, created_at', [a.userId, b.body, b.app_version ?? null, b.platform ?? null]),
  );
  res.status(201).json(row);
});

// GET /me/feedback-history — ratings the citizen gave (brief §5 citizen dashboard)
meRouter.get('/feedback-history', async (req, res) => {
  const a = actorOf(req);
  const rows = await withTx(a, (db) => many(db, 'SELECT * FROM v_citizen_feedback_history WHERE citizen_id = $1 ORDER BY created_at DESC', [a.userId]));
  res.json(rows);
});

// DELETE /me — privacy: erase personal details, keep anonymous incident history
meRouter.delete('/', async (req, res) => {
  const a = actorOf(req);
  if (a.role !== 'citizen') throw badRequest('Staff accounts are removed by an administrator');
  await withTx(a, async (db) => {
    await db.query(
      `UPDATE users SET email = 'deleted+' || id || '@invalid.example', full_name = 'Deleted user', phone = NULL,
              password_hash = NULL, status = 'inactive', deleted_at = now() WHERE id = $1`,
      [a.userId],
    );
    await db.query('UPDATE citizen_profiles SET home_suburb = NULL, home_location = NULL WHERE user_id = $1', [a.userId]);
    await db.query('UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [a.userId]);
    await db.query('DELETE FROM device_push_tokens WHERE user_id = $1', [a.userId]);
    await db.query(`INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES ($1, 'account_erased', 'user', $2)`, [a.userId, String(a.userId)]);
  });
  res.status(204).end();
});
