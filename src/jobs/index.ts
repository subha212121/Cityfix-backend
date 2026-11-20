import { many, one, pool, withTx } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { sendMail } from '../lib/mailer.js';
import { monthlySummary, summariseIncident } from '../ai/service.js';
import { notify } from '../services/notify.js';
export { runExportJobs } from './exports.js';

/** Email/push outbox: FOR UPDATE SKIP LOCKED lets several workers share the queue. */
export async function deliverNotifications(batch = 50) {
  const rows = await withTx(null, (db) =>
    many(
      db,
      `SELECT d.id, d.channel, d.attempts, n.title, n.body, n.incident_id, u.email, u.full_name
         FROM notification_deliveries d
         JOIN notifications n ON n.id = d.notification_id
         JOIN users u ON u.id = n.user_id
        WHERE d.status = 'queued' AND d.next_attempt_at <= now()
        ORDER BY d.next_attempt_at LIMIT $1 FOR UPDATE OF d SKIP LOCKED`,
      [batch],
    ).then(async (list) => {
      for (const d of list) await db.query(`UPDATE notification_deliveries SET attempts = attempts + 1, next_attempt_at = now() + interval '5 minutes' WHERE id = $1`, [d.id]); // claim
      return list;
    }),
  );
  let sent = 0;
  for (const d of rows) {
    try {
      if (d.channel === 'email') {
        const id = await sendMail(d.email, d.title, `Hi ${d.full_name},\n\n${d.body ?? d.title}\n\n— CityFix`);
        await pool.query(`UPDATE notification_deliveries SET status = 'sent', sent_at = now(), provider_message_id = $2 WHERE id = $1`, [d.id, id]);
        sent++;
      } else {
        // Push needs an Expo/FCM key; until one is configured the delivery is marked skipped.
        await pool.query(`UPDATE notification_deliveries SET status = 'skipped', last_error = 'push provider not configured' WHERE id = $1`, [d.id]);
      }
    } catch (err: any) {
      const giveUp = d.attempts + 1 >= 5;
      await pool.query(
        `UPDATE notification_deliveries SET status = $2, last_error = $3,
                next_attempt_at = now() + make_interval(mins => power(2, $4)::int) WHERE id = $1`,
        [d.id, giveUp ? 'failed' : 'queued', String(err?.message ?? err).slice(0, 300), d.attempts + 1],
      );
    }
  }
  return sent;
}

/** SLA due within 24 h / breached → officer (or department) alert, once per incident per state. */
export async function slaAlerts() {
  return withTx(null, async (db) => {
    const due = await many(
      db,
      `SELECT v.id, v.reference_no, v.title, v.sla_state, v.assigned_officer_id, v.assigned_department_id
         FROM v_officer_queue v
        WHERE v.sla_state IN ('due_soon', 'overdue')
          AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.incident_id = v.id
                           AND n.event = CASE v.sla_state WHEN 'overdue' THEN 'sla_breached'::notification_event ELSE 'sla_due_soon'::notification_event END)`,
    );
    for (const i of due) {
      const event = i.sla_state === 'overdue' ? 'sla_breached' : 'sla_due_soon';
      const to = i.assigned_officer_id
        ? [i.assigned_officer_id]
        : (await many(db, `SELECT user_id FROM officer_profiles WHERE department_id = $1 AND is_supervisor`, [i.assigned_department_id])).map((r) => r.user_id);
      for (const u of to) await notify(db, u, event, `${i.reference_no} ${event === 'sla_breached' ? 'is past its SLA' : 'is due within 24 hours'}`, i.title, i.id);
    }
    return due.length;
  });
}

export const autoClose = () => withTx(null, async (db) => (await one(db, 'SELECT auto_close_resolved_incidents() AS n'))?.n ?? 0);

export const refreshStats = () => pool.query('SELECT refresh_incident_stats()');

/** AI summaries for long reports and for incidents that gained merged duplicates (FR-27). */
export async function generateSummaries(limit = 10) {
  const ids = await withTx(null, (db) =>
    many<{ id: number }>(
      db,
      `SELECT i.id FROM incidents i
        WHERE i.deleted_at IS NULL AND i.status NOT IN ('closed', 'rejected')
          AND (
            (i.ai_summary IS NULL AND char_length(i.description) >= coalesce(
                (SELECT (config->>'min_description_chars')::int FROM ai_settings WHERE feature = 'incident_summary'), 400))
            OR EXISTS (SELECT 1 FROM incidents d WHERE d.merged_into_id = i.id
                        AND d.updated_at > coalesce(i.ai_summary_updated_at, '-infinity'))
          )
        ORDER BY i.created_at LIMIT $1`,
      [limit],
    ),
  );
  for (const { id } of ids) {
    try {
      await withTx(null, (db) => summariseIncident(db, id));
    } catch (err) {
      logger.warn({ err, id }, 'summary failed');
    }
  }
  return ids.length;
}

/** Previous calendar month summary for the admin dashboard. */
export async function previousMonthSummary(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return withTx(null, (db) => monthlySummary(db, start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)));
}
