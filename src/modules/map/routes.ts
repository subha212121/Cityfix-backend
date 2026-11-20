import { Router } from 'express';
import { z } from 'zod';
import { many, withTx } from '../../db/pool.js';
import { actorOf, csv, isStaff } from '../../lib/http.js';
import { requireAuth, staffOnly } from '../../middleware/auth.js';

export const mapRouter = Router();
mapRouter.use(requireAuth);

const Bbox = z.object({
  min_lat: z.coerce.number().min(-90).max(90),
  min_lng: z.coerce.number().min(-180).max(180),
  max_lat: z.coerce.number().min(-90).max(90),
  max_lng: z.coerce.number().min(-180).max(180),
  category_id: z.coerce.number().int().optional(),
  priority: csv(z.enum(['low', 'medium', 'high', 'critical'])),
  state: z.enum(['open', 'resolved', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(5000).default(2000),
});

// GET /map/incidents — pins for C3 / O3: location, severity (priority), open vs resolved, category filter
mapRouter.get('/incidents', async (req, res) => {
  const a = actorOf(req);
  const q = Bbox.parse(req.query);
  // Citizens see the public view; staff see every incident.
  const source = isStaff(a)
    ? `(SELECT i.id, i.reference_no, i.title, i.status, i.priority, i.category_id, c.name AS category, i.address,
               ST_Y(i.location::geometry) AS lat, ST_X(i.location::geometry) AS lng,
               i.status NOT IN ('resolved','closed','rejected') AS is_open, i.supporter_count, i.created_at, i.location
          FROM incidents i JOIN categories c ON c.id = i.category_id
         WHERE i.deleted_at IS NULL AND i.merged_into_id IS NULL)`
    : `(SELECT v.*, i.location FROM v_public_incidents v JOIN incidents i ON i.id = v.id)`;
  const rows = await withTx(a, (db) =>
    many(
      db,
      `SELECT m.id, m.reference_no, m.title, m.status, m.priority AS severity, m.category_id, m.category,
              p.id AS parent_category_id, coalesce(p.name, m.category) AS top_category,
              m.lat, m.lng, m.is_open, m.supporter_count, m.created_at
         FROM ${source} m
         JOIN categories c ON c.id = m.category_id
         LEFT JOIN categories p ON p.id = c.parent_id
        WHERE m.location && ST_MakeEnvelope($1, $2, $3, $4, 4326)::geography
          AND ($5::smallint IS NULL OR m.category_id = $5 OR c.parent_id = $5)
          AND ($6::priority_level[] IS NULL OR m.priority = ANY ($6))
          AND ($7 = 'all' OR ($7 = 'open') = m.is_open)
        ORDER BY m.created_at DESC
        LIMIT $8`,
      [q.min_lng, q.min_lat, q.max_lng, q.max_lat, q.category_id ?? null, q.priority ?? null, q.state, q.limit],
    ),
  );
  res.json({ count: rows.length, incidents: rows });
});

// GET /map/nearby — "Near you" on C1 and the duplicate hint on C2
mapRouter.get('/nearby', async (req, res) => {
  const a = actorOf(req);
  const q = z
    .object({
      lat: z.coerce.number().min(-90).max(90),
      lng: z.coerce.number().min(-180).max(180),
      radius_m: z.coerce.number().int().min(10).max(10_000).default(1000),
      category_id: z.coerce.number().int().optional(),
    })
    .parse(req.query);
  const rows = await withTx(a, (db) =>
    many(db, 'SELECT * FROM incidents_nearby($1, $2, $3, $4)', [q.lat, q.lng, q.radius_m, q.category_id ?? null]),
  );
  res.json({ count: rows.length, incidents: rows });
});

// GET /map/heatmap — hotspots for A1 / O3
mapRouter.get('/heatmap', staffOnly, async (req, res) => {
  const a = actorOf(req);
  const q = z
    .object({
      from: z.coerce.date().default(() => new Date(Date.now() - 30 * 864e5)),
      to: z.coerce.date().default(() => new Date()),
      cell_m: z.coerce.number().int().min(50).max(5000).default(250),
    })
    .parse(req.query);
  const cells = await withTx(a, (db) => many(db, 'SELECT * FROM incident_heatmap($1, $2, $3) ORDER BY incident_count DESC', [q.from, q.to, q.cell_m]));
  res.json({ cell_m: q.cell_m, cells });
});
