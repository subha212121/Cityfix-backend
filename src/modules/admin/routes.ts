import { Router } from 'express';
import { z } from 'zod';
import { many, one, withTx } from '../../db/pool.js';
import { isProd } from '../../config.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { actorOf, IdParam, Page, pageClause, paged, UuidParam } from '../../lib/http.js';
import { appLink, sendMailLater } from '../../lib/mailer.js';
import { newOpaqueToken } from '../../lib/security.js';
import { adminOnly, requireAuth } from '../../middleware/auth.js';
import { suggestClassification } from '../../ai/service.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, adminOnly);

const audit = (db: any, actor: string, action: string, type: string, id: string, before: unknown, after: unknown) =>
  db.query('INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, before_data, after_data) VALUES ($1, $2, $3, $4, $5, $6)', [
    actor, action, type, id, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null,
  ]);

// ---------------------------------------------------------------------------
// Users and roles (A2, A6, FR-03)
// ---------------------------------------------------------------------------
adminRouter.get('/users', async (req, res) => {
  const a = actorOf(req);
  const q = Page.extend({
    role: z.enum(['citizen', 'officer', 'admin']).optional(),
    status: z.enum(['pending', 'active', 'inactive']).optional(),
    department_id: z.coerce.number().int().optional(),
    q: z.string().trim().max(100).optional(),
  }).parse(req.query);
  const { limit, offset } = pageClause(q);
  const rows = await withTx(a, (db) =>
    many(
      db,
      `SELECT v.id, v.full_name, v.email, v.role, v.status, v.department_id, d.name AS department, v.team_id, t.name AS team,
              v.employee_no, v.last_active_at, v.created_at, count(*) OVER () AS total_count
         FROM v_users v LEFT JOIN departments d ON d.id = v.department_id LEFT JOIN teams t ON t.id = v.team_id
        WHERE v.deleted_at IS NULL AND ($1::user_role IS NULL OR v.role = $1) AND ($2::account_status IS NULL OR v.status = $2)
          AND ($3::smallint IS NULL OR v.department_id = $3)
          AND ($4::text IS NULL OR v.full_name ILIKE '%' || $4 || '%' OR v.email::text ILIKE '%' || $4 || '%')
        ORDER BY v.role DESC, v.full_name LIMIT $5 OFFSET $6`,
      [q.role ?? null, q.status ?? null, q.department_id ?? null, q.q ?? null, limit, offset],
    ),
  );
  res.json(paged(rows, q));
});

adminRouter.get('/users/:id', async (req, res) => {
  const a = actorOf(req);
  const { id } = UuidParam.parse(req.params);
  const u = await withTx(a, (db) => one(db, 'SELECT * FROM v_users WHERE id = $1', [id]));
  if (!u) throw notFound('User');
  res.json(u);
});

// PATCH /admin/users/:id — details, status, role change (moves the profile row)
adminRouter.patch('/users/:id', async (req, res) => {
  const a = actorOf(req);
  const { id } = UuidParam.parse(req.params);
  const b = z
    .object({
      full_name: z.string().trim().min(2).max(120).optional(),
      status: z.enum(['active', 'inactive']).optional(),
      role: z.enum(['citizen', 'officer', 'admin']).optional(),
      employee_no: z.string().trim().max(30).optional(),
      department_id: z.number().int().positive().nullable().optional(),
      team_id: z.number().int().positive().nullable().optional(),
      position_title: z.string().trim().max(80).optional(),
      is_supervisor: z.boolean().optional(),
      access_level: z.enum(['standard', 'super']).optional(),
    })
    .parse(req.body);
  if (id === a.userId && (b.status === 'inactive' || (b.role && b.role !== 'admin'))) throw badRequest('You cannot deactivate or demote yourself');

  const user = await withTx(a, async (db) => {
    await db.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [id]);
    const before = await one(db, 'SELECT * FROM v_users WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!before) throw notFound('User');
    if (b.full_name || b.status) {
      await db.query('UPDATE users SET full_name = coalesce($2, full_name), status = coalesce($3, status) WHERE id = $1', [id, b.full_name ?? null, b.status ?? null]);
      if (b.status === 'inactive') await db.query('UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    }
    if (b.role && b.role !== before.role) {
      await db.query('SELECT change_user_role($1, $2, $3, $4, $5)', [id, b.role, b.employee_no ?? before.employee_no ?? null, b.department_id ?? null, b.team_id ?? null]);
    } else if (before.role === 'officer') {
      await db.query(
        `UPDATE officer_profiles SET employee_no = coalesce($2, employee_no), department_id = coalesce($3, department_id),
                team_id = CASE WHEN $4::boolean THEN $5 ELSE team_id END, position_title = coalesce($6, position_title),
                is_supervisor = coalesce($7, is_supervisor) WHERE user_id = $1`,
        [id, b.employee_no ?? null, b.department_id ?? null, b.team_id !== undefined, b.team_id ?? null, b.position_title ?? null, b.is_supervisor ?? null],
      );
    } else if (before.role === 'admin') {
      await db.query(
        `UPDATE admin_profiles SET employee_no = coalesce($2, employee_no), department_id = CASE WHEN $3::boolean THEN $4 ELSE department_id END,
                access_level = coalesce($5, access_level) WHERE user_id = $1`,
        [id, b.employee_no ?? null, b.department_id !== undefined, b.department_id ?? null, b.access_level ?? null],
      );
    }
    const after = await one(db, 'SELECT * FROM v_users WHERE id = $1', [id]);
    await audit(db, a.userId, b.status === 'inactive' ? 'user_deactivated' : 'user_updated', 'user', id,
      { role: before.role, status: before.status, department_id: before.department_id }, { role: after.role, status: after.status, department_id: after.department_id });
    return after;
  });
  res.json(user);
});

// POST /admin/users/:id/send-password-reset (A6)
adminRouter.post('/users/:id/send-password-reset', async (req, res) => {
  const a = actorOf(req);
  const { id } = UuidParam.parse(req.params);
  const token = await withTx(a, async (db) => {
    const u = await one(db, 'SELECT email, full_name FROM users WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!u) throw notFound('User');
    const t = newOpaqueToken();
    await db.query(`INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1, 'password_reset', $2, now() + interval '24 hours')`, [id, t.hash]);
    await audit(db, a.userId, 'password_reset_sent', 'user', id, null, null);
    sendMailLater(u.email, 'Set a new CityFix password', `Hi ${u.full_name},\n\nAn administrator asked us to send you a password link:\n${appLink(`/reset-password?token=${t.token}`)}`);
    return t.token;
  });
  res.status(202).json({ sent: true, ...(isProd ? {} : { dev_token: token }) });
});

// Invitations for officers and admins (A2 "Invite officer")
adminRouter.post('/invitations', async (req, res) => {
  const a = actorOf(req);
  const b = z
    .object({
      email: z.email().transform((e) => e.toLowerCase()),
      role: z.enum(['officer', 'admin']),
      employee_no: z.string().trim().min(1).max(30),
      department_id: z.number().int().positive().optional(),
      team_id: z.number().int().positive().optional(),
    })
    .refine((v) => v.role !== 'officer' || v.department_id, { message: 'Officers need a department', path: ['department_id'] })
    .parse(req.body);
  const out = await withTx(a, async (db) => {
    if (await one(db, 'SELECT 1 FROM users WHERE email = $1', [b.email])) throw conflict('A user with this email already exists');
    if (b.team_id && !(await one(db, 'SELECT 1 FROM teams WHERE id = $1 AND department_id = $2', [b.team_id, b.department_id]))) {
      throw badRequest('That team is not in the chosen department');
    }
    const t = newOpaqueToken();
    const inv = await one(
      db,
      `INSERT INTO staff_invitations (email, role, employee_no, department_id, team_id, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '7 days') RETURNING id, email, role, expires_at`,
      [b.email, b.role, b.employee_no, b.department_id ?? null, b.team_id ?? null, t.hash, a.userId],
    );
    await audit(db, a.userId, 'user_invited', 'invitation', inv.id, null, { email: b.email, role: b.role, department_id: b.department_id });
    sendMailLater(b.email, 'You are invited to CityFix', `You have been invited to CityFix as ${b.role}.\nSet up your account (link valid 7 days):\n${appLink(`/accept-invite?token=${t.token}`)}`);
    return { ...inv, ...(isProd ? {} : { dev_token: t.token }) };
  });
  res.status(201).json(out);
});

adminRouter.get('/invitations', async (req, res) => {
  const a = actorOf(req);
  res.json(await withTx(a, (db) => many(db, `SELECT id, email, role, employee_no, department_id, team_id, expires_at, accepted_at, revoked_at, created_at FROM staff_invitations ORDER BY created_at DESC LIMIT 200`)));
});

adminRouter.delete('/invitations/:id', async (req, res) => {
  const a = actorOf(req);
  const { id } = UuidParam.parse(req.params);
  await withTx(a, (db) => db.query('UPDATE staff_invitations SET revoked_at = now() WHERE id = $1 AND accepted_at IS NULL', [id]));
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Departments and teams
// ---------------------------------------------------------------------------
adminRouter.post('/departments', async (req, res) => {
  const a = actorOf(req);
  const b = z.object({ name: z.string().trim().min(2).max(80), code: z.string().trim().min(2).max(12).toUpperCase(), email: z.email().optional() }).parse(req.body);
  res.status(201).json(await withTx(a, (db) => one(db, 'INSERT INTO departments (name, code, email) VALUES ($1, $2, $3) RETURNING *', [b.name, b.code, b.email ?? null])));
});
adminRouter.patch('/departments/:id', async (req, res) => {
  const a = actorOf(req);
  const { id } = IdParam.parse(req.params);
  const b = z.object({ name: z.string().trim().min(2).max(80).optional(), email: z.email().nullable().optional(), is_active: z.boolean().optional() }).parse(req.body);
  const r = await withTx(a, (db) =>
    one(db, `UPDATE departments SET name = coalesce($2, name), email = CASE WHEN $3::boolean THEN $4 ELSE email END, is_active = coalesce($5, is_active) WHERE id = $1 RETURNING *`,
      [id, b.name ?? null, b.email !== undefined, b.email ?? null, b.is_active ?? null]),
  );
  if (!r) throw notFound('Department');
  res.json(r);
});
adminRouter.post('/teams', async (req, res) => {
  const a = actorOf(req);
  const b = z.object({ department_id: z.number().int().positive(), name: z.string().trim().min(2).max(80), is_field_crew: z.boolean().default(true) }).parse(req.body);
  res.status(201).json(await withTx(a, (db) => one(db, 'INSERT INTO teams (department_id, name, is_field_crew) VALUES ($1, $2, $3) RETURNING *', [b.department_id, b.name, b.is_field_crew])));
});
adminRouter.patch('/teams/:id', async (req, res) => {
  const a = actorOf(req);
  const { id } = IdParam.parse(req.params);
  const b = z.object({ name: z.string().trim().min(2).max(80).optional(), is_field_crew: z.boolean().optional(), is_active: z.boolean().optional() }).parse(req.body);
  const r = await withTx(a, (db) =>
    one(db, 'UPDATE teams SET name = coalesce($2, name), is_field_crew = coalesce($3, is_field_crew), is_active = coalesce($4, is_active) WHERE id = $1 RETURNING *', [id, b.name ?? null, b.is_field_crew ?? null, b.is_active ?? null]),
  );
  if (!r) throw notFound('Team');
  res.json(r);
});

// ---------------------------------------------------------------------------
// Categories, keywords and SLAs (A3, FR-23)
// ---------------------------------------------------------------------------
adminRouter.get('/categories', async (req, res) => {
  const a = actorOf(req);
  res.json(
    await withTx(a, (db) =>
      many(
        db,
        `SELECT c.*, p.name AS parent_name, d.name AS department, t.name AS team,
                coalesce(array_agg(k.keyword::text ORDER BY k.keyword) FILTER (WHERE k.keyword IS NOT NULL), '{}') AS keywords,
                (SELECT json_agg(json_build_object('priority', o.priority, 'sla_hours', o.sla_hours)) FROM sla_priority_overrides o WHERE o.category_id = c.id) AS sla_overrides
           FROM categories c LEFT JOIN categories p ON p.id = c.parent_id
           JOIN departments d ON d.id = c.default_department_id LEFT JOIN teams t ON t.id = c.default_team_id
           LEFT JOIN category_keywords k ON k.category_id = c.id
          GROUP BY c.id, p.name, d.name, t.name, p.sort_order
          ORDER BY coalesce(p.sort_order, c.sort_order), c.parent_id NULLS FIRST, c.sort_order`,
      ),
    ),
  );
});

const CategoryBody = z.object({
  parent_id: z.number().int().positive().nullable().optional(),
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().regex(/^[a-z0-9-]+$/).max(60),
  description: z.string().max(300).optional(),
  default_department_id: z.number().int().positive(),
  default_team_id: z.number().int().positive().nullable().optional(),
  sla_days: z.number().int().min(1).max(365),
  keywords: z.array(z.string().trim().min(2).max(60)).max(50).default([]),
  is_active: z.boolean().default(true),
  sort_order: z.number().int().default(0),
});

async function replaceKeywords(db: any, id: number, keywords: string[]) {
  await db.query('DELETE FROM category_keywords WHERE category_id = $1', [id]);
  for (const k of new Set(keywords.map((x) => x.toLowerCase()))) await db.query('INSERT INTO category_keywords (category_id, keyword) VALUES ($1, $2)', [id, k]);
}

adminRouter.post('/categories', async (req, res) => {
  const a = actorOf(req);
  const b = CategoryBody.parse(req.body);
  const r = await withTx(a, async (db) => {
    const c = await one(
      db,
      `INSERT INTO categories (parent_id, name, slug, description, default_department_id, default_team_id, sla_days, is_active, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [b.parent_id ?? null, b.name, b.slug, b.description ?? null, b.default_department_id, b.default_team_id ?? null, b.sla_days, b.is_active, b.sort_order],
    );
    await replaceKeywords(db, c.id, b.keywords);
    await audit(db, a.userId, 'category_created', 'category', String(c.id), null, b);
    return c;
  });
  res.status(201).json(r);
});

adminRouter.patch('/categories/:id', async (req, res) => {
  const a = actorOf(req);
  const { id } = IdParam.parse(req.params);
  const b = CategoryBody.partial().parse(req.body);
  const r = await withTx(a, async (db) => {
    const before = await one(db, 'SELECT * FROM categories WHERE id = $1', [id]);
    if (!before) throw notFound('Category');
    const c = await one(
      db,
      `UPDATE categories SET name = coalesce($2, name), description = coalesce($3, description),
              default_department_id = coalesce($4, default_department_id),
              default_team_id = CASE WHEN $5::boolean THEN $6 ELSE default_team_id END,
              sla_days = coalesce($7, sla_days), is_active = coalesce($8, is_active), sort_order = coalesce($9, sort_order)
        WHERE id = $1 RETURNING *`,
      [id, b.name ?? null, b.description ?? null, b.default_department_id ?? null, b.default_team_id !== undefined, b.default_team_id ?? null, b.sla_days ?? null, b.is_active ?? null, b.sort_order ?? null],
    );
    if (b.keywords) await replaceKeywords(db, id, b.keywords);
    await audit(db, a.userId, before.sla_days !== c.sla_days ? 'sla_edited' : 'category_updated', 'category', String(id),
      { sla_days: before.sla_days, name: before.name, is_active: before.is_active }, { sla_days: c.sla_days, name: c.name, is_active: c.is_active });
    return c;
  });
  res.json(r);
});

adminRouter.put('/categories/:id/sla-overrides', async (req, res) => {
  const a = actorOf(req);
  const { id } = IdParam.parse(req.params);
  const rows = z.array(z.object({ priority: z.enum(['low', 'medium', 'high', 'critical']), sla_hours: z.number().int().positive().max(8760) })).max(4).parse(req.body);
  await withTx(a, async (db) => {
    await db.query('DELETE FROM sla_priority_overrides WHERE category_id = $1', [id]);
    for (const r of rows) await db.query('INSERT INTO sla_priority_overrides (category_id, priority, sla_hours) VALUES ($1, $2, $3)', [id, r.priority, r.sla_hours]);
    await audit(db, a.userId, 'sla_edited', 'category', String(id), null, rows);
  });
  res.json({ updated: rows.length });
});

// ---------------------------------------------------------------------------
// AI settings (A4, FR-30)
// ---------------------------------------------------------------------------
adminRouter.get('/ai-settings', async (req, res) => {
  const a = actorOf(req);
  res.json(await withTx(a, (db) => many(db, 'SELECT * FROM ai_settings ORDER BY feature')));
});

adminRouter.put('/ai-settings/:feature', async (req, res) => {
  const a = actorOf(req);
  const feature = z.enum(['categorize', 'prioritize', 'incident_summary', 'chatbot', 'monthly_summary']).parse(req.params.feature);
  const b = z
    .object({ is_enabled: z.boolean(), auto_apply_threshold: z.number().min(0).max(1).nullable().optional(), config: z.record(z.string(), z.unknown()).optional() })
    .parse(req.body);
  const r = await withTx(a, async (db) => {
    const before = await one(db, 'SELECT * FROM ai_settings WHERE feature = $1', [feature]);
    const after = await one(
      db,
      `UPDATE ai_settings SET is_enabled = $2, auto_apply_threshold = CASE WHEN $3::boolean THEN $4 ELSE auto_apply_threshold END,
              config = coalesce($5, config), updated_by = $6, updated_at = now() WHERE feature = $1 RETURNING *`,
      [feature, b.is_enabled, b.auto_apply_threshold !== undefined, b.auto_apply_threshold ?? null, b.config ? JSON.stringify(b.config) : null, a.userId],
    );
    await audit(db, a.userId, 'ai_settings_changed', 'ai_settings', feature, before, after);
    return after;
  });
  res.json(r);
});

// POST /admin/ai-settings/test — "Test the AI" panel on A4
adminRouter.post('/ai-settings/test', async (req, res) => {
  const a = actorOf(req);
  const { text } = z.object({ text: z.string().trim().min(10).max(4000) }).parse(req.body);
  res.json(await withTx(a, (db) => suggestClassification(db, { description: text })));
});

// ---------------------------------------------------------------------------
// Audit log (A7, FR-16) · app feedback · settings · FAQ
// ---------------------------------------------------------------------------
adminRouter.get('/audit-logs', async (req, res) => {
  const a = actorOf(req);
  const q = Page.extend({
    action: z.string().max(60).optional(),
    entity_type: z.string().max(40).optional(),
    entity_id: z.string().max(80).optional(),
    actor_id: z.uuid().optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  }).parse(req.query);
  const { limit, offset } = pageClause(q);
  const rows = await withTx(a, (db) =>
    many(
      db,
      `SELECT l.id, l.created_at, l.action, l.entity_type, l.entity_id, l.before_data, l.after_data, l.ip_address,
              l.actor_id, coalesce(u.full_name, 'System') AS actor, count(*) OVER () AS total_count
         FROM audit_logs l LEFT JOIN users u ON u.id = l.actor_id
        WHERE ($1::text IS NULL OR l.action = $1) AND ($2::text IS NULL OR l.entity_type = $2) AND ($3::text IS NULL OR l.entity_id = $3)
          AND ($4::uuid IS NULL OR l.actor_id = $4) AND ($5::timestamptz IS NULL OR l.created_at >= $5) AND ($6::timestamptz IS NULL OR l.created_at < $6)
        ORDER BY l.created_at DESC, l.id DESC LIMIT $7 OFFSET $8`,
      [q.action ?? null, q.entity_type ?? null, q.entity_id ?? null, q.actor_id ?? null, q.from ?? null, q.to ?? null, limit, offset],
    ),
  );
  res.json(paged(rows, q));
});

adminRouter.get('/feedback', async (req, res) => {
  const a = actorOf(req);
  res.json(await withTx(a, (db) => many(db, `SELECT f.*, u.full_name FROM app_feedback f LEFT JOIN users u ON u.id = f.user_id ORDER BY f.created_at DESC LIMIT 200`)));
});
adminRouter.patch('/feedback/:id', async (req, res) => {
  const a = actorOf(req);
  const { id } = IdParam.parse(req.params);
  const { status } = z.object({ status: z.enum(['new', 'reviewed', 'actioned']) }).parse(req.body);
  res.json(await withTx(a, (db) => one(db, 'UPDATE app_feedback SET status = $2 WHERE id = $1 RETURNING *', [id, status])));
});

adminRouter.get('/settings', async (req, res) => {
  const a = actorOf(req);
  res.json(await withTx(a, (db) => many(db, 'SELECT key, value, description, updated_at FROM system_settings ORDER BY key')));
});
adminRouter.put('/settings/:key', async (req, res) => {
  const a = actorOf(req);
  const key = z.string().regex(/^[a-z_]+$/).parse(req.params.key);
  const { value } = z.object({ value: z.union([z.number(), z.string(), z.boolean()]) }).parse(req.body);
  const r = await withTx(a, async (db) => {
    const before = await one(db, 'SELECT value FROM system_settings WHERE key = $1', [key]);
    if (!before) throw notFound('Setting');
    const after = await one(db, 'UPDATE system_settings SET value = $2, updated_by = $3, updated_at = now() WHERE key = $1 RETURNING key, value', [key, JSON.stringify(value), a.userId]);
    await audit(db, a.userId, 'setting_changed', 'system_setting', key, before, after);
    return after;
  });
  res.json(r);
});

adminRouter.post('/faq', async (req, res) => {
  const a = actorOf(req);
  const b = z.object({ question: z.string().trim().min(5).max(300), answer: z.string().trim().min(5).max(3000), sort_order: z.number().int().default(0), is_published: z.boolean().default(true) }).parse(req.body);
  res.status(201).json(await withTx(a, (db) => one(db, 'INSERT INTO faq_articles (question, answer, sort_order, is_published, updated_by) VALUES ($1, $2, $3, $4, $5) RETURNING *', [b.question, b.answer, b.sort_order, b.is_published, a.userId])));
});
adminRouter.patch('/faq/:id', async (req, res) => {
  const a = actorOf(req);
  const { id } = IdParam.parse(req.params);
  const b = z.object({ question: z.string().trim().min(5).max(300).optional(), answer: z.string().trim().min(5).max(3000).optional(), is_published: z.boolean().optional() }).parse(req.body);
  res.json(await withTx(a, (db) => one(db, 'UPDATE faq_articles SET question = coalesce($2, question), answer = coalesce($3, answer), is_published = coalesce($4, is_published), updated_by = $5 WHERE id = $1 RETURNING *', [id, b.question ?? null, b.answer ?? null, b.is_published ?? null, a.userId])));
});
