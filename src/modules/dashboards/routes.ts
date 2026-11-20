import { Router } from 'express';
import { z } from 'zod';
import { many, one, withTx } from '../../db/pool.js';
import { actorOf } from '../../lib/http.js';
import { adminOnly, citizenOnly, requireAuth, staffOnly } from '../../middleware/auth.js';

export const dashboardsRouter = Router();
dashboardsRouter.use(requireAuth);

// GET /dashboard/citizen — submitted incidents, status, notifications, feedback history (brief §5)
dashboardsRouter.get('/citizen', citizenOnly, async (req, res) => {
  const a = actorOf(req);
  const out = await withTx(a, async (db) => ({
    by_status: await many(db, `SELECT status, count(*) AS n FROM incidents WHERE reporter_id = $1 AND deleted_at IS NULL GROUP BY status`, [a.userId]),
    recent_reports: await many(
      db,
      `SELECT i.id, i.reference_no, i.title, i.status, c.name AS category, i.created_at, i.updated_at
         FROM incidents i JOIN categories c ON c.id = i.category_id
        WHERE i.reporter_id = $1 AND i.deleted_at IS NULL ORDER BY i.created_at DESC LIMIT 5`,
      [a.userId],
    ),
    unread_notifications: (await one(db, 'SELECT count(*) AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [a.userId]))?.n ?? 0,
    awaiting_my_rating: await many(
      db,
      `SELECT i.id, i.reference_no, i.title, i.resolved_at FROM incidents i
        WHERE i.reporter_id = $1 AND i.status = 'resolved'
          AND NOT EXISTS (SELECT 1 FROM incident_ratings r WHERE r.incident_id = i.id AND r.resolution_cycle = i.reopen_count)`,
      [a.userId],
    ),
    feedback_history: await many(db, 'SELECT * FROM v_citizen_feedback_history WHERE citizen_id = $1 ORDER BY created_at DESC LIMIT 10', [a.userId]),
  }));
  res.json(out);
});

// GET /dashboard/officer — assigned, pending, resolution statistics, department workload (brief §5, O1/O4)
dashboardsRouter.get('/officer', staffOnly, async (req, res) => {
  const a = actorOf(req);
  const q = z.object({ department_id: z.coerce.number().int().optional() }).parse(req.query);
  const out = await withTx(a, async (db) => {
    const dept =
      q.department_id ??
      (await one(db, 'SELECT coalesce(o.department_id, ad.department_id) AS d FROM users u LEFT JOIN officer_profiles o ON o.user_id = u.id LEFT JOIN admin_profiles ad ON ad.user_id = u.id WHERE u.id = $1', [a.userId]))?.d ??
      null;
    // Admins without a department see the whole council
    const scope = `($1::smallint IS NULL OR assigned_department_id = $1) AND deleted_at IS NULL AND merged_into_id IS NULL`;
    return {
      department_id: dept,
      kpis: await one(
        db,
        `SELECT count(*) FILTER (WHERE status IN ('new','under_review'))                                   AS new_needs_review,
                count(*) FILTER (WHERE status NOT IN ('resolved','closed','rejected') AND priority IN ('high','critical')) AS high_priority,
                count(*) FILTER (WHERE status = 'in_progress')                                              AS in_progress,
                count(*) FILTER (WHERE status NOT IN ('resolved','closed','rejected') AND sla_due_at < now()) AS past_sla,
                count(*) FILTER (WHERE assigned_officer_id = $2 AND status IN ('assigned','in_progress'))     AS assigned_to_me
           FROM incidents WHERE ${scope}`,
        [dept, a.userId],
      ),
      assigned_to_me: await many(
        db,
        `SELECT id, reference_no, title, status, priority, sla_due_at, sla_state FROM v_officer_queue
          WHERE assigned_officer_id = $1 AND status IN ('assigned','in_progress') ORDER BY sla_due_at LIMIT 10`,
        [a.userId],
      ),
      pending_cases: await many(
        db,
        `SELECT id, reference_no, title, status, priority, created_at, sla_state FROM v_officer_queue
          WHERE ($1::smallint IS NULL OR assigned_department_id = $1) AND status IN ('new','under_review')
          ORDER BY CASE priority WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, created_at LIMIT 10`,
        [dept],
      ),
      resolution_stats: await one(
        db,
        `SELECT count(*) FILTER (WHERE resolved_at >= date_trunc('month', now()))                       AS resolved_this_month,
                round(avg(extract(epoch FROM resolved_at - created_at) / 86400)
                      FILTER (WHERE resolved_at > now() - interval '30 days')::numeric, 1)              AS avg_days_to_resolve_30d,
                round(100.0 * count(*) FILTER (WHERE resolved_at > now() - interval '30 days' AND resolved_at <= sla_due_at)
                      / nullif(count(*) FILTER (WHERE resolved_at > now() - interval '30 days'), 0), 1) AS within_sla_pct_30d
           FROM incidents WHERE ${scope}`,
        [dept],
      ),
      resolved_per_week: await many(
        db,
        `SELECT date_trunc('week', resolved_at)::date AS week, count(*) AS resolved
           FROM incidents WHERE ${scope} AND resolved_at > now() - interval '8 weeks'
          GROUP BY 1 ORDER BY 1`,
        [dept],
      ),
      department_workload: await many(db, 'SELECT * FROM v_department_workload WHERE ($1::smallint IS NULL OR department_id = $1) ORDER BY open_assigned DESC', [dept]),
      oldest_open: await many(
        db,
        `SELECT id, reference_no, title, status, priority, created_at, sla_due_at, officer, team FROM v_officer_queue
          WHERE ($1::smallint IS NULL OR assigned_department_id = $1) AND status NOT IN ('resolved','closed','rejected')
          ORDER BY created_at LIMIT 5`,
        [dept],
      ),
    };
  });
  res.json(out);
});

// GET /dashboard/admin — volume trends, popular categories, resolution times, hotspots, usage (brief §5, A1)
dashboardsRouter.get('/admin', adminOnly, async (req, res) => {
  const a = actorOf(req);
  const q = z
    .object({
      from: z.coerce.date().default(() => new Date(Date.now() - 30 * 864e5)),
      to: z.coerce.date().default(() => new Date()),
      ward_id: z.coerce.number().int().optional(),
    })
    .parse(req.query);
  const span = q.to.getTime() - q.from.getTime();
  const prevFrom = new Date(q.from.getTime() - span);
  const w = `($3::smallint IS NULL OR ward_id = $3) AND deleted_at IS NULL`;
  const p = [q.from, q.to, q.ward_id ?? null];

  const out = await withTx(a, async (db) => ({
    period: { from: q.from, to: q.to, ward_id: q.ward_id ?? null },
    kpis: await one(
      db,
      `SELECT count(*) FILTER (WHERE created_at >= $1 AND created_at < $2)                                       AS reports_received,
              count(*) FILTER (WHERE created_at >= $4 AND created_at < $1)                                       AS previous_period_received,
              count(*) FILTER (WHERE status NOT IN ('resolved','closed','rejected'))                             AS still_open,
              count(*) FILTER (WHERE status NOT IN ('resolved','closed','rejected') AND sla_due_at < now())       AS past_sla,
              round(avg(extract(epoch FROM resolved_at - created_at) / 86400)
                    FILTER (WHERE resolved_at >= $1 AND resolved_at < $2)::numeric, 1)                          AS avg_days_to_resolve,
              (SELECT round(avg(r.score)::numeric, 2) FROM incident_ratings r WHERE r.created_at >= $1 AND r.created_at < $2) AS citizen_rating,
              (SELECT count(*) FROM incident_ratings r WHERE r.created_at >= $1 AND r.created_at < $2)          AS rating_count
         FROM incidents WHERE ${w} AND merged_into_id IS NULL`,
      [...p, prevFrom],
    ),
    volume_trend: await many(
      db,
      `SELECT d::date AS day,
              (SELECT count(*) FROM incidents WHERE ${w} AND created_at::date = d::date)  AS received,
              (SELECT count(*) FROM incidents WHERE ${w} AND resolved_at::date = d::date) AS resolved
         FROM generate_series($1::date, $2::date, interval '1 day') d`,
      p,
    ),
    popular_categories: await many(
      db,
      `SELECT coalesce(pc.id, c.id) AS category_id, coalesce(pc.name, c.name) AS category, count(*) AS reports,
              round(avg(extract(epoch FROM i.resolved_at - i.created_at) / 86400)::numeric, 1) AS avg_days_to_resolve
         FROM incidents i JOIN categories c ON c.id = i.category_id LEFT JOIN categories pc ON pc.id = c.parent_id
        WHERE i.created_at >= $1 AND i.created_at < $2 AND ($3::smallint IS NULL OR i.ward_id = $3) AND i.deleted_at IS NULL
        GROUP BY 1, 2 ORDER BY reports DESC`,
      p,
    ),
    by_status: await many(db, `SELECT status, count(*) AS n FROM incidents WHERE ${w} AND created_at >= $1 AND created_at < $2 GROUP BY status`, p),
    by_ward: await many(
      db,
      `SELECT w.id AS ward_id, w.name AS ward, count(i.id) AS reports FROM wards w
         LEFT JOIN incidents i ON i.ward_id = w.id AND i.created_at >= $1 AND i.created_at < $2 AND i.deleted_at IS NULL
        GROUP BY w.id ORDER BY reports DESC`,
      [q.from, q.to],
    ),
    hotspots: await many(db, 'SELECT * FROM incident_heatmap($1, $2, 250) ORDER BY incident_count DESC LIMIT 50', [q.from, q.to]),
    system_usage: await one(
      db,
      `SELECT sum(new_citizens) AS new_citizens, sum(sign_ins) AS sign_ins, sum(incidents_reported) AS incidents_reported,
              sum(chat_sessions) AS chat_sessions, sum(ai_calls) AS ai_calls, sum(ai_failures) AS ai_failures,
              (SELECT count(*) FROM users WHERE last_active_at > now() - interval '30 days') AS active_users_30d,
              (SELECT count(*) FROM users WHERE role = 'citizen' AND deleted_at IS NULL) AS citizens_total,
              (SELECT count(*) FROM users WHERE role IN ('officer','admin') AND status = 'active') AS staff_active
         FROM v_system_usage_daily WHERE day >= $1::date AND day <= $2::date`,
      [q.from, q.to],
    ),
    ai_accuracy: await many(db, `SELECT * FROM v_ai_accuracy WHERE month >= date_trunc('month', $1::timestamptz) ORDER BY month, feature`, [q.from]),
    monthly_summary: await one(db, 'SELECT period_start, period_end, body, created_at FROM analytics_summaries WHERE ward_id IS NULL ORDER BY period_end DESC LIMIT 1'),
  }));
  res.json(out);
});
