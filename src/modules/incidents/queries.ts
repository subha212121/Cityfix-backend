import { many, one, type Actor, type Db } from '../../db/pool.js';
import { notFound } from '../../lib/errors.js';
import { presignDownload } from '../../lib/storage.js';

export const STATUSES = ['new', 'under_review', 'assigned', 'in_progress', 'resolved', 'closed', 'rejected'] as const;
export const OPEN_STATUSES = ['new', 'under_review', 'assigned', 'in_progress'] as const;
export const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;

/** Full incident for C5 (citizen) and O2 (officer), shaped by who is asking. */
export async function incidentDetail(db: Db, id: number, actor: Actor) {
  const i = await one(
    db,
    `SELECT i.id, i.reference_no, i.title, i.description, i.status, i.priority, i.priority_source,
            i.category_id, c.name AS category, p.id AS parent_category_id, coalesce(p.name, c.name) AS top_category,
            i.category_source, i.ai_category_id, ac.name AS ai_category, i.ai_priority, i.ai_priority_reason, i.ai_confidence,
            i.ai_summary, i.ai_summary_updated_at,
            ST_Y(i.location::geometry) AS lat, ST_X(i.location::geometry) AS lng, i.address,
            i.ward_id, w.name AS ward, i.occurred_at, i.created_at, i.updated_at,
            i.assigned_department_id, d.name AS department, i.assigned_team_id, t.name AS team,
            i.assigned_officer_id, o.full_name AS officer,
            i.sla_due_at, i.first_reviewed_at, i.assigned_at, i.work_started_at, i.resolved_at, i.closed_at,
            i.resolution_note, i.closure_reason, i.reopen_count,
            i.merged_into_id, m.reference_no AS merged_into_reference,
            (SELECT count(*) FROM incidents x WHERE x.merged_into_id = i.id) AS merged_reports,
            i.supporter_count, i.is_public, i.is_anonymous, i.reporter_id, r.full_name AS reporter_name
       FROM incidents i
       JOIN categories c ON c.id = i.category_id
       LEFT JOIN categories p ON p.id = c.parent_id
       LEFT JOIN categories ac ON ac.id = i.ai_category_id
       LEFT JOIN wards w ON w.id = i.ward_id
       LEFT JOIN departments d ON d.id = i.assigned_department_id
       LEFT JOIN teams t ON t.id = i.assigned_team_id
       LEFT JOIN users o ON o.id = i.assigned_officer_id
       LEFT JOIN incidents m ON m.id = i.merged_into_id
       LEFT JOIN users r ON r.id = i.reporter_id
      WHERE i.id = $1 AND i.deleted_at IS NULL`,
    [id],
  );
  if (!i) throw notFound('Incident'); // RLS also hides other citizens' private reports

  const staff = actor.role !== 'citizen';
  const mine = i.reporter_id === actor.userId;

  const attachments = await many(
    db,
    `SELECT id, kind, storage_key, mime_type, size_bytes, moderation, uploaded_by, created_at
       FROM incident_attachments WHERE incident_id = $1 AND message_id IS NULL ORDER BY kind, sort_order, created_at`,
    [id],
  );
  const photos = await Promise.all(
    attachments
      .filter((a) => staff || a.uploaded_by === actor.userId || a.moderation === 'approved')
      .map(async (a) => ({ id: a.id, kind: a.kind, moderation: staff ? a.moderation : undefined, url: await presignDownload(a.storage_key), created_at: a.created_at })),
  );

  const history = await many(
    db,
    `SELECT h.id, h.from_status, h.to_status, h.note, h.is_public, h.created_at,
            CASE WHEN $2 THEN u.full_name END AS changed_by
       FROM incident_status_history h LEFT JOIN users u ON u.id = h.changed_by
      WHERE h.incident_id = $1 AND (h.is_public OR $2)
      ORDER BY h.id`,
    [id, staff],
  );

  const transitions = await many(
    db,
    `SELECT to_status, description FROM incident_status_transitions
      WHERE from_status = $1 AND $2::user_role = ANY (allowed_roles)`,
    [i.status, actor.role],
  );

  const rating = mine
    ? await one(db, 'SELECT id, score, comment, requested_reopen, created_at FROM incident_ratings WHERE incident_id = $1 AND resolution_cycle = $2', [id, i.reopen_count])
    : null;

  const reporter = staff
    ? { reporter: i.is_anonymous ? 'Anonymous citizen' : i.reporter_name, reporter_id: i.is_anonymous ? null : i.reporter_id }
    : {};
  const { reporter_id, reporter_name, ...rest } = i;
  const aiInternal = staff ? {} : { ai_confidence: undefined, ai_summary: undefined, ai_summary_updated_at: undefined };

  return {
    ...rest,
    ...aiInternal,
    ...reporter,
    is_mine: mine,
    photos,
    history,
    allowed_status_changes: staff || mine ? transitions : [],
    my_rating: rating,
    can_rate: mine && i.status === 'resolved' && !rating,
  };
}

export const priorityOrder = `CASE priority WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END`;
