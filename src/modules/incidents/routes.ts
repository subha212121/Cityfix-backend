import { Router } from 'express';
import { z } from 'zod';
import { many, one, setStatusNote, withTx, type Actor, type Db } from '../../db/pool.js';
import { badRequest, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { actorOf, csv, IdParam, isStaff, Page, pageClause, paged } from '../../lib/http.js';
import { ALLOWED_IMAGE_TYPES, MAX_PHOTO_BYTES, uploadPrefix, type ImageType } from '../../lib/storage.js';
import { citizenOnly, requireAuth, staffOnly } from '../../middleware/auth.js';
import { suggestClassification, summariseIncident } from '../../ai/service.js';
import { incidentStaff, notify, STATUS_LABEL } from '../../services/notify.js';
import { incidentDetail, OPEN_STATUSES, priorityOrder, PRIORITIES, STATUSES } from './queries.js';

export const incidentsRouter = Router();
incidentsRouter.use(requireAuth);

const Photo = z.object({
  storage_key: z.string().min(10).max(300),
  mime_type: z.enum(Object.keys(ALLOWED_IMAGE_TYPES) as [ImageType, ...ImageType[]], { message: 'Only JPG or PNG photos' }),
  size_bytes: z.number().int().positive().max(MAX_PHOTO_BYTES, 'Each photo can be up to 5 MB'),
});

function checkOwnKey(actor: Actor, key: string) {
  if (!key.startsWith(uploadPrefix(actor.userId))) throw forbidden('That photo was not uploaded by you');
}

// ---------------------------------------------------------------------------
// POST /incidents — citizen submits a report (C2, FR-05 … FR-08, FR-25/26)
// ---------------------------------------------------------------------------
const CreateIncident = z.object({
  title: z.string().trim().min(3, 'Add a short title').max(120),
  description: z.string().trim().min(10, 'Describe the issue in a few words').max(4000),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  location_accuracy_m: z.number().min(0).max(10_000).optional(),
  address: z.string().trim().max(300).optional(),
  occurred_at: z.coerce.date().refine((d) => d.getTime() <= Date.now() + 5 * 60_000, 'Date seen cannot be in the future').optional(),
  category_id: z.number().int().positive().optional(),
  prediction_id: z.number().int().positive().optional(),
  is_anonymous: z.boolean().optional(),
  photos: z.array(Photo).max(3, 'Up to 3 photos').default([]),
});

incidentsRouter.post('/', citizenOnly, async (req, res) => {
  const a = actorOf(req);
  const b = CreateIncident.parse(req.body);
  b.photos.forEach((p) => checkOwnKey(a, p.storage_key));

  const out = await withTx(a, async (db) => {
    // AI suggestion made while the citizen typed (POST /ai/suggest), or run now
    let pred = b.prediction_id
      ? await one(
          db,
          `SELECT id, suggested_category_id, suggested_priority, reason, confidence, run_status
             FROM ai_predictions WHERE id = $1 AND feature = 'categorize' AND incident_id IS NULL
              AND created_at > now() - interval '2 hours'`,
          [b.prediction_id],
        )
      : null;
    if (b.prediction_id && !pred) throw badRequest('That AI suggestion has expired. Ask for a new one.');
    if (!pred && !b.category_id) {
      const s = await suggestClassification(db, { title: b.title, description: b.description });
      pred = { id: s.prediction_id, suggested_category_id: s.category_id, suggested_priority: s.priority, reason: s.reason, confidence: s.confidence };
    }

    const categoryId = b.category_id ?? pred?.suggested_category_id;
    if (!categoryId) throw unprocessable('We could not work out the category. Please choose one.');
    const cat = await one(db, 'SELECT id FROM categories WHERE id = $1 AND is_active', [categoryId]);
    if (!cat) throw badRequest('Unknown category');

    const usedAiCategory = !!pred && pred.suggested_category_id === categoryId;
    const priority = pred?.suggested_priority ?? 'medium';
    const anon =
      b.is_anonymous ?? (await one<{ d: boolean }>(db, 'SELECT default_anonymous AS d FROM citizen_profiles WHERE user_id = $1', [a.userId]))?.d ?? false;

    const inc = await one<{ id: number; reference_no: string }>(
      db,
      `INSERT INTO incidents (title, description, reporter_id, is_anonymous, location, location_accuracy_m, address,
                              occurred_at, category_id, category_source, priority, priority_source,
                              ai_category_id, ai_priority, ai_priority_reason, ai_confidence)
       VALUES ($1, $2, $3, $4, ST_MakePoint($6, $5)::geography, $7, $8, coalesce($9, now()), $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING id, reference_no`,
      [
        b.title, b.description, a.userId, anon, b.lat, b.lng, b.location_accuracy_m ?? null, b.address ?? null,
        b.occurred_at ?? null, categoryId, usedAiCategory ? 'ai' : 'citizen', priority, pred ? 'ai' : 'default',
        pred?.suggested_category_id ?? null, pred?.suggested_priority ?? null, pred?.reason ?? null, pred?.confidence ?? null,
      ],
    );

    for (const [i, p] of b.photos.entries()) {
      await db.query(
        `INSERT INTO incident_attachments (incident_id, uploaded_by, kind, storage_key, mime_type, size_bytes, sort_order)
         VALUES ($1, $2, 'citizen_photo', $3, $4, $5, $6)`,
        [inc!.id, a.userId, p.storage_key, p.mime_type, p.size_bytes, i],
      );
    }
    if (pred) {
      await db.query(
        `UPDATE ai_predictions SET incident_id = $2, decision = $3, decided_by = $4, decided_at = now(),
                final_category_id = $5, final_priority = $6 WHERE id = $1`,
        [pred.id, inc!.id, usedAiCategory ? 'accepted' : 'overridden', a.userId, categoryId, priority],
      );
    }

    await notify(db, a.userId, 'report_received', `Thanks, your report ${inc!.reference_no} is in`,
      'We will let you know as soon as an officer reviews it.', inc!.id, { reference_no: inc!.reference_no });
    if (priority === 'critical') {
      for (const officer of await incidentStaff(db, inc!.id)) {
        await notify(db, officer, 'incident_assigned', `Critical report ${inc!.reference_no}: ${b.title}`, pred?.reason ?? null, inc!.id);
      }
    }

    const duplicates = await many(db, 'SELECT * FROM find_duplicate_candidates($1)', [inc!.id]);
    return { detail: await incidentDetail(db, inc!.id, a), possible_duplicates: duplicates };
  });
  res.status(201).json({ ...out.detail, possible_duplicates: out.possible_duplicates });
});

// ---------------------------------------------------------------------------
// GET /incidents — citizen: "My reports" (C4) · staff: work queue (O1, A5)
// ---------------------------------------------------------------------------
const ListQuery = Page.extend({
  status: csv(z.enum(STATUSES)),
  priority: csv(z.enum(PRIORITIES)),
  category_id: z.coerce.number().int().optional(),
  ward_id: z.coerce.number().int().optional(),
  department_id: z.coerce.number().int().optional(),
  team_id: z.coerce.number().int().optional(),
  assigned: z.enum(['me', 'unassigned', 'any']).default('any'),
  sla_state: z.enum(['overdue', 'due_soon', 'on_track']).optional(),
  q: z.string().trim().min(2).max(100).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  sort: z.enum(['priority', 'newest', 'oldest', 'sla_due']).default('priority'),
});

incidentsRouter.get('/', async (req, res) => {
  const a = actorOf(req);
  const q = ListQuery.parse(req.query);
  const { limit, offset } = pageClause(q);

  if (!isStaff(a)) {
    const rows = await withTx(a, (db) =>
      many(
        db,
        `SELECT i.id, i.reference_no, i.title, i.status, i.priority, c.name AS category, coalesce(p.name, c.name) AS top_category,
                i.address, i.created_at, i.updated_at, i.resolved_at,
                (SELECT storage_key FROM incident_attachments x WHERE x.incident_id = i.id AND x.kind = 'citizen_photo' ORDER BY sort_order LIMIT 1) AS thumbnail_key,
                count(*) OVER () AS total_count
           FROM incidents i JOIN categories c ON c.id = i.category_id LEFT JOIN categories p ON p.id = c.parent_id
          WHERE i.reporter_id = $1 AND i.deleted_at IS NULL
            AND ($2::incident_status[] IS NULL OR i.status = ANY ($2))
          ORDER BY i.created_at DESC LIMIT $3 OFFSET $4`,
        [a.userId, q.status ?? null, limit, offset],
      ),
    );
    return res.json(paged(rows, q));
  }

  const order = {
    priority: `${priorityOrder} DESC, v.created_at ASC`,
    newest: 'v.created_at DESC',
    oldest: 'v.created_at ASC',
    sla_due: 'v.sla_due_at ASC NULLS LAST',
  }[q.sort];
  const rows = await withTx(a, (db) =>
    many(
      db,
      `SELECT v.*, count(*) OVER () AS total_count
         FROM v_officer_queue v
        WHERE v.status = ANY ($1)
          AND ($2::priority_level[] IS NULL OR v.priority = ANY ($2))
          AND ($3::smallint IS NULL OR v.category_id = $3 OR v.category_id IN (SELECT id FROM categories WHERE parent_id = $3))
          AND ($4::smallint IS NULL OR v.ward_id = $4)
          AND ($5::smallint IS NULL OR v.assigned_department_id = $5)
          AND ($6::smallint IS NULL OR v.assigned_team_id = $6)
          AND ($7 <> 'me' OR v.assigned_officer_id = $8)
          AND ($7 <> 'unassigned' OR (v.assigned_officer_id IS NULL AND v.assigned_team_id IS NULL))
          AND ($9::text IS NULL OR v.sla_state = $9)
          AND ($10::text IS NULL OR v.id IN (SELECT id FROM incidents
                 WHERE search_vector @@ websearch_to_tsquery('english', $10) OR reference_no ILIKE $10 || '%' OR title % $10))
          AND ($11::timestamptz IS NULL OR v.created_at >= $11)
          AND ($12::timestamptz IS NULL OR v.created_at < $12)
        ORDER BY ${order}
        LIMIT $13 OFFSET $14`,
      [
        q.status ?? [...OPEN_STATUSES], q.priority ?? null, q.category_id ?? null, q.ward_id ?? null, q.department_id ?? null,
        q.team_id ?? null, q.assigned, a.userId, q.sla_state ?? null, q.q ?? null, q.from ?? null, q.to ?? null, limit, offset,
      ],
    ),
  );
  res.json(paged(rows, q));
});

// GET /incidents/:id
incidentsRouter.get('/:id', async (req, res) => {
  const a = actorOf(req);
  const { id } = IdParam.parse(req.params);
  res.json(await withTx(a, (db) => incidentDetail(db, id, a)));
});

// ---------------------------------------------------------------------------
// PATCH /incidents/:id — officer review, status, assignment, AI override (O2, FR-10/11/28)
// ---------------------------------------------------------------------------
const UpdateIncident = z
  .object({
    status: z.enum(STATUSES).optional(),
    closure_reason: z.enum(['closed_by_staff', 'invalid', 'not_council_responsibility', 'spam']).optional(),
    note: z.string().trim().max(2000).optional(),
    note_is_public: z.boolean().default(true),
    category_id: z.number().int().positive().optional(),
    priority: z.enum(PRIORITIES).optional(),
    assigned_department_id: z.number().int().positive().nullable().optional(),
    assigned_team_id: z.number().int().positive().nullable().optional(),
    assigned_officer_id: z.uuid().nullable().optional(),
    resolution_note: z.string().trim().max(2000).optional(),
    is_public: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'note_is_public'), 'Nothing to update');

incidentsRouter.patch('/:id', staffOnly, async (req, res) => {
  const a = actorOf(req);
  const { id } = IdParam.parse(req.params);
  const b = UpdateIncident.parse(req.body);

  const detail = await withTx(a, async (db) => {
    const cur = await one(db, 'SELECT * FROM incidents WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]);
    if (!cur) throw notFound('Incident');

    const set: string[] = [];
    const params: unknown[] = [id];
    const put = (col: string, val: unknown) => {
      params.push(val);
      set.push(`${col} = $${params.length}`);
    };

    // Assignment: a team implies its department; an officer implies theirs
    let dept = b.assigned_department_id;
    if (b.assigned_team_id) {
      const t = await one<{ department_id: number }>(db, 'SELECT department_id FROM teams WHERE id = $1 AND is_active', [b.assigned_team_id]);
      if (!t) throw badRequest('Unknown team');
      dept = t.department_id;
    }
    if (b.assigned_officer_id) {
      const o = await one<{ department_id: number }>(db, 'SELECT department_id FROM officer_profiles WHERE user_id = $1', [b.assigned_officer_id]);
      if (!o) throw badRequest('That user is not an officer');
      dept ??= o.department_id;
    }
    if (dept !== undefined) put('assigned_department_id', dept);
    if (b.assigned_team_id !== undefined) put('assigned_team_id', b.assigned_team_id);
    if (b.assigned_officer_id !== undefined) put('assigned_officer_id', b.assigned_officer_id);

    // Classification: staff value wins, AI value is kept (FR-28)
    if (b.category_id !== undefined && b.category_id !== cur.category_id) {
      put('category_id', b.category_id);
      put('category_source', 'staff');
    }
    if (b.priority !== undefined && b.priority !== cur.priority) {
      put('priority', b.priority);
      put('priority_source', 'staff');
    }
    if (b.is_public !== undefined) put('is_public', b.is_public);

    if (b.status && b.status !== cur.status) {
      if (b.status === 'rejected' && !['invalid', 'not_council_responsibility', 'spam'].includes(b.closure_reason ?? '')) {
        throw unprocessable('Give a reason: invalid, not_council_responsibility or spam');
      }
      put('status', b.status);
      if (b.status === 'closed' || b.status === 'rejected') put('closure_reason', b.closure_reason ?? 'closed_by_staff');
      if (b.status === 'resolved') put('resolution_note', b.resolution_note ?? b.note ?? cur.resolution_note);
    } else if (b.resolution_note !== undefined) put('resolution_note', b.resolution_note);

    if (set.length) {
      await setStatusNote(db, b.note);
      await db.query(`UPDATE incidents SET ${set.join(', ')} WHERE id = $1`, params);
      await setStatusNote(db, null);
    }
    // A note without a status change still goes on the timeline
    if (b.note && !(b.status && b.status !== cur.status)) {
      await db.query(
        'INSERT INTO incident_status_history (incident_id, from_status, to_status, changed_by, note, is_public) VALUES ($1, $2, $2, $3, $4, $5)',
        [id, cur.status, a.userId, b.note, b.note_is_public],
      );
    } else if (b.note && !b.note_is_public) {
      await db.query(
        `UPDATE incident_status_history SET is_public = false WHERE id = (SELECT max(id) FROM incident_status_history WHERE incident_id = $1)`,
        [id],
      );
    }

    // Record the human decision on the AI suggestion
    if (b.category_id !== undefined || b.priority !== undefined || (b.status === 'under_review' && cur.status === 'new')) {
      const after = await one(db, 'SELECT category_id, priority FROM incidents WHERE id = $1', [id]);
      await db.query(
        `UPDATE ai_predictions SET decision = CASE WHEN suggested_category_id = $2 AND suggested_priority = $3
                                                 THEN 'accepted'::ai_decision ELSE 'overridden'::ai_decision END,
                decided_by = $4, decided_at = now(), final_category_id = $2, final_priority = $3
          WHERE id = (SELECT max(id) FROM ai_predictions WHERE incident_id = $1 AND feature = 'categorize')`,
        [id, after.category_id, after.priority, a.userId],
      );
    }

    // Notifications (FR-13)
    const ref = cur.reference_no as string;
    if (b.status && b.status !== cur.status) {
      const publicNote = b.note_is_public ? b.note : undefined;
      if (b.status === 'resolved') {
        await notify(db, cur.reporter_id, 'rating_requested', `${ref} is resolved – how did we do?`, publicNote ?? 'Rate the fix, or reopen it if the problem is still there.', id);
      } else {
        await notify(db, cur.reporter_id, 'status_changed', `${ref} is now ${STATUS_LABEL[b.status]}`, publicNote ?? null, id, { status: b.status });
      }
    } else if (b.note && b.note_is_public) {
      await notify(db, cur.reporter_id, 'status_changed', `Update on ${ref}`, b.note, id);
    }
    if (b.assigned_officer_id && b.assigned_officer_id !== cur.assigned_officer_id) {
      await notify(db, b.assigned_officer_id, 'incident_assigned', `${ref} assigned to you`, cur.title, id);
      if (cur.assigned_officer_id) await notify(db, cur.assigned_officer_id, 'incident_reassigned', `${ref} moved to another officer`, null, id);
    }
    return incidentDetail(db, id, a);
  });
  res.json(detail);
});

// POST /incidents/:id/merge — mark as duplicate of another (O2 "Merge duplicate")
incidentsRouter.post('/:id/merge', staffOnly, async (req, res) => {
  const a = actorOf(req);
  const { id } = IdParam.parse(req.params);
  const b = z.object({ into_id: z.number().int().positive(), note: z.string().max(500).optional() }).parse(req.body);
  const out = await withTx(a, async (db) => {
    const dup = await one(db, 'SELECT reference_no, reporter_id FROM incidents WHERE id = $1', [id]);
    const primary = await one(db, 'SELECT reference_no FROM incidents WHERE id = $1', [b.into_id]);
    if (!dup || !primary) throw notFound('Incident');
    await db.query('SELECT merge_incident($1, $2, $3)', [id, b.into_id, b.note ?? null]);
    await notify(db, dup.reporter_id, 'status_changed', `${dup.reference_no} joined ${primary.reference_no}`,
      'Someone already reported this. We merged your report so you get updates on the main one.', b.into_id);
    return incidentDetail(db, b.into_id, a);
  });
  res.json(out);
});

// GET /incidents/:id/duplicates — candidates within the duplicate radius
incidentsRouter.get('/:id/duplicates', staffOnly, async (req, res) => {
  const a = actorOf(req);
  const { id } = IdParam.parse(req.params);
  res.json(await withTx(a, (db) => many(db, 'SELECT * FROM find_duplicate_candidates($1)', [id])));
});

// POST/DELETE /incidents/:id/support — "I see this too" (C3)
incidentsRouter.post('/:id/support', citizenOnly, async (req, res) => {
  const a = actorOf(req);
  const { id } = IdParam.parse(req.params);
  const b = z.object({ comment: z.string().max(500).optional() }).parse(req.body ?? {});
  const r = await withTx(a, async (db) => {
    const inc = await one(db, `SELECT reporter_id, status FROM incidents WHERE id = $1 AND is_public AND deleted_at IS NULL`, [id]);
    if (!inc) throw notFound('Incident');
    if (inc.reporter_id === a.userId) throw badRequest('You reported this one');
    if (['closed', 'rejected'].includes(inc.status)) throw badRequest('This incident is closed');
    await db.query('INSERT INTO incident_supporters (incident_id, user_id, comment) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, a.userId, b.comment ?? null]);
    return one(db, 'SELECT supporter_count FROM incidents WHERE id = $1', [id]);
  });
  res.status(201).json(r);
});
incidentsRouter.delete('/:id/support', citizenOnly, async (req, res) => {
  const a = actorOf(req);
  const { id } = IdParam.parse(req.params);
  await withTx(a, (db) => db.query('DELETE FROM incident_supporters WHERE incident_id = $1 AND user_id = $2', [id, a.userId]));
  res.status(204).end();
});

// GET /incidents/:id/history — status timeline (FR-12)
incidentsRouter.get('/:id/history', async (req, res) => {
  const a = actorOf(req);
  const { id } = IdParam.parse(req.params);
  res.json(await withTx(a, async (db) => (await incidentDetail(db, id, a)).history));
});

// ---------------------------------------------------------------------------
// Messages between officer and citizen (C10, FR-14)
// ---------------------------------------------------------------------------
incidentsRouter.get('/:id/messages', async (req, res) => {
  const a = actorOf(req);
  const { id } = IdParam.parse(req.params);
  const rows = await withTx(a, async (db) => {
    await incidentDetail(db, id, a); // visibility check
    const msgs = await many(
      db,
      `SELECT m.id, m.body, m.is_internal, m.created_at, m.read_at, m.sender_id = $2 AS is_mine,
              CASE WHEN s.role = 'citizen' THEN 'citizen' ELSE 'council' END AS sender_type,
              CASE WHEN s.role <> 'citizen' THEN coalesce(d.name, 'Council') ELSE 'You' END AS sender_label
         FROM incident_messages m
         JOIN users s ON s.id = m.sender_id
         LEFT JOIN officer_profiles o ON o.user_id = s.id
         LEFT JOIN departments d ON d.id = o.department_id
        WHERE m.incident_id = $1 AND m.deleted_at IS NULL ORDER BY m.created_at`,
      [id, a.userId],
    );
    // mark the other side's messages as read
    await db.query('UPDATE incident_messages SET read_at = now() WHERE incident_id = $1 AND sender_id <> $2 AND read_at IS NULL AND NOT is_internal', [id, a.userId]);
    return msgs;
  });
  res.json(rows);
});

incidentsRouter.post('/:id/messages', async (req, res) => {
  const a = actorOf(req);
  const { id } = IdParam.parse(req.params);
  const b = z.object({ body: z.string().trim().min(1).max(4000), is_internal: z.boolean().default(false) }).parse(req.body);
  if (b.is_internal && !isStaff(a)) throw forbidden('Only staff can write internal notes');
  const msg = await withTx(a, async (db) => {
    const inc = await one(db, 'SELECT reference_no, reporter_id, status FROM incidents WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!inc) throw notFound('Incident');
    if (!isStaff(a) && inc.reporter_id !== a.userId) throw forbidden('You can only message about your own reports');
    const m = await one(db, 'INSERT INTO incident_messages (incident_id, sender_id, body, is_internal) VALUES ($1, $2, $3, $4) RETURNING id, created_at', [id, a.userId, b.body, b.is_internal]);
    if (!b.is_internal) {
      if (isStaff(a)) {
        await notify(db, inc.reporter_id, 'message_received', `New message about ${inc.reference_no}`, b.body.slice(0, 140), id);
      } else {
        for (const officer of await incidentStaff(db, id)) {
          await notify(db, officer, 'message_received', `Citizen replied on ${inc.reference_no}`, b.body.slice(0, 140), id);
        }
      }
    }
    return m;
  });
  res.status(201).json(msg);
});

// ---------------------------------------------------------------------------
// POST /incidents/:id/rating — rate the fix, or reopen (C11, FR-15)
// ---------------------------------------------------------------------------
incidentsRouter.post('/:id/rating', citizenOnly, async (req, res) => {
  const a = actorOf(req);
  const { id } = IdParam.parse(req.params);
  const b = z
    .object({
      score: z.number().int().min(1).max(5),
      tags: z.array(z.string().max(40)).max(10).default([]),
      comment: z.string().trim().max(1000).optional(),
      reopen: z.boolean().default(false),
    })
    .parse(req.body);

  const out = await withTx(a, async (db) => {
    const inc = await one(db, 'SELECT reference_no, status FROM incidents WHERE id = $1 AND reporter_id = $2', [id, a.userId]);
    if (!inc) throw notFound('Incident');
    const r = await one<{ id: number }>(
      db,
      'INSERT INTO incident_ratings (incident_id, citizen_id, score, comment, requested_reopen) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [id, a.userId, b.score, b.comment ?? null, b.reopen],
    );
    for (const t of new Set(b.tags)) {
      await db.query('INSERT INTO incident_rating_tags (rating_id, tag_code) VALUES ($1, $2)', [r!.id, t]);
    }
    if (b.reopen) {
      await setStatusNote(db, `Reopened by citizen${b.comment ? `: ${b.comment}` : ''}`);
      await db.query(`UPDATE incidents SET status = 'in_progress' WHERE id = $1`, [id]);
    } else {
      await setStatusNote(db, 'Confirmed fixed by citizen');
      await db.query(`UPDATE incidents SET status = 'closed', closure_reason = 'confirmed_by_citizen' WHERE id = $1`, [id]);
    }
    await setStatusNote(db, null);
    for (const officer of await incidentStaff(db, id)) {
      await notify(db, officer, b.reopen ? 'incident_reopened' : 'rating_received',
        b.reopen ? `${inc.reference_no} reopened by the citizen` : `${inc.reference_no} rated ${b.score}/5`, b.comment ?? null, id);
    }
    return incidentDetail(db, id, a);
  });
  res.status(201).json(out);
});

// ---------------------------------------------------------------------------
// Photos after creation: citizen adds to own new report; staff add before/after
// ---------------------------------------------------------------------------
incidentsRouter.post('/:id/attachments', async (req, res) => {
  const a = actorOf(req);
  const { id } = IdParam.parse(req.params);
  const b = Photo.extend({ kind: z.enum(['citizen_photo', 'before_photo', 'after_photo']).default('citizen_photo') }).parse(req.body);
  checkOwnKey(a, b.storage_key);
  const row = await withTx(a, async (db) => {
    const inc = await one(db, 'SELECT reporter_id, status FROM incidents WHERE id = $1', [id]);
    if (!inc) throw notFound('Incident');
    if (!isStaff(a)) {
      if (inc.reporter_id !== a.userId || b.kind !== 'citizen_photo') throw forbidden();
      if (!['new', 'under_review'].includes(inc.status)) throw badRequest('Photos can be added until the report is assigned');
    } else if (b.kind === 'citizen_photo') throw badRequest('Staff upload before_photo or after_photo');
    return one(
      db,
      `INSERT INTO incident_attachments (incident_id, uploaded_by, kind, storage_key, mime_type, size_bytes, moderation)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, kind, created_at`,
      [id, a.userId, b.kind, b.storage_key, b.mime_type, b.size_bytes, isStaff(a) ? 'approved' : 'pending'],
    );
  });
  res.status(201).json(row);
});

// PATCH /incidents/:id/attachments/:attachmentId — photo moderation (staff)
incidentsRouter.patch('/:id/attachments/:attachmentId', staffOnly, async (req, res) => {
  const a = actorOf(req);
  const { id } = IdParam.parse(req.params);
  const attachmentId = z.uuid().parse(req.params.attachmentId);
  const { moderation } = z.object({ moderation: z.enum(['approved', 'hidden']) }).parse(req.body);
  const r = await withTx(a, async (db) => {
    const row = await one(db, 'UPDATE incident_attachments SET moderation = $3 WHERE id = $2 AND incident_id = $1 RETURNING id, moderation', [id, attachmentId, moderation]);
    if (row) {
      await db.query(`INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, after_data) VALUES ($1, 'photo_moderated', 'attachment', $2, $3)`,
        [a.userId, attachmentId, JSON.stringify({ moderation, incident_id: id })]);
    }
    return row;
  });
  if (!r) throw notFound('Photo');
  res.json(r);
});

// POST /incidents/:id/summary — (re)generate the AI summary (O2 "Regenerate", FR-27)
incidentsRouter.post('/:id/summary', staffOnly, async (req, res) => {
  const a = actorOf(req);
  const { id } = IdParam.parse(req.params);
  const summary = await withTx(a, async (db: Db) => {
    if (!(await one(db, 'SELECT 1 FROM incidents WHERE id = $1', [id]))) throw notFound('Incident');
    return summariseIncident(db, id);
  });
  res.json({ ai_summary: summary });
});

// ---------------------------------------------------------------------------
// POST /ai/suggest — category + priority while the citizen types (C2, FR-25/26)
// ---------------------------------------------------------------------------
export const aiRouter = Router();
aiRouter.use(requireAuth);
aiRouter.post('/suggest', async (req, res) => {
  const a = actorOf(req);
  const b = z.object({ title: z.string().max(120).optional(), description: z.string().trim().min(10).max(4000) }).parse(req.body);
  const s = await withTx(a, async (db) => {
    const r = await suggestClassification(db, b);
    const cat = r.category_id
      ? await one(db, 'SELECT c.id, c.name, p.id AS parent_id, p.name AS parent_name FROM categories c LEFT JOIN categories p ON p.id = c.parent_id WHERE c.id = $1', [r.category_id])
      : null;
    return { ...r, category: cat };
  });
  res.json(s);
});
