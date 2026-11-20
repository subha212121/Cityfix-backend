import type { Db } from '../db/pool.js';

export type NotificationEvent =
  | 'report_received' | 'status_changed' | 'message_received' | 'rating_requested'
  | 'incident_assigned' | 'incident_reassigned' | 'incident_reopened' | 'sla_due_soon'
  | 'sla_breached' | 'rating_received' | 'chat_handover' | 'daily_queue_summary' | 'export_ready';

/**
 * In-app notification + email/push queued per the user's preferences.
 * Runs through the SECURITY DEFINER function so any role can notify another.
 */
export async function notify(
  db: Db,
  userId: string | null | undefined,
  event: NotificationEvent,
  title: string,
  body?: string | null,
  incidentId?: number | null,
  data: Record<string, unknown> = {},
) {
  if (!userId) return null;
  const r = await db.query('SELECT create_notification($1, $2, $3, $4, $5, $6) AS id', [
    userId, event, title, body ?? null, incidentId ?? null, JSON.stringify(data),
  ]);
  return r.rows[0]?.id as number | null;
}

/** Officers who should hear about an incident: the assigned officer, else everyone in its department. */
export async function incidentStaff(db: Db, incidentId: number): Promise<string[]> {
  const r = await db.query(
    `SELECT CASE WHEN i.assigned_officer_id IS NOT NULL THEN array[i.assigned_officer_id]
                ELSE array(SELECT o.user_id FROM officer_profiles o JOIN users u ON u.id = o.user_id
                            WHERE o.department_id = i.assigned_department_id AND u.status = 'active') END AS ids
       FROM incidents i WHERE i.id = $1`,
    [incidentId],
  );
  return (r.rows[0]?.ids ?? []).filter(Boolean);
}

export const STATUS_LABEL: Record<string, string> = {
  new: 'New', under_review: 'Under Review', assigned: 'Assigned', in_progress: 'In Progress',
  resolved: 'Resolved', closed: 'Closed', rejected: 'Rejected',
};
