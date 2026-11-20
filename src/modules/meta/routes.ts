import { Router } from 'express';
import { many, pool, withTx } from '../../db/pool.js';

export const metaRouter = Router();

// Public reference data used by the apps (no sign-in needed)

// GET /meta/categories — the six brief categories with their subcategories
metaRouter.get('/categories', async (_req, res) => {
  const rows = await withTx(null, (db) =>
    many(
      db,
      `SELECT p.id, p.name, p.slug, p.description, p.sla_days,
              coalesce(json_agg(json_build_object('id', c.id, 'name', c.name, 'slug', c.slug, 'sla_days', c.sla_days)
                       ORDER BY c.sort_order) FILTER (WHERE c.id IS NOT NULL), '[]') AS subcategories
         FROM categories p
         LEFT JOIN categories c ON c.parent_id = p.id AND c.is_active
        WHERE p.parent_id IS NULL AND p.is_active
        GROUP BY p.id ORDER BY p.sort_order`,
    ),
  );
  res.json(rows);
});

metaRouter.get('/departments', async (_req, res) => {
  const rows = await withTx(null, (db) =>
    many(
      db,
      `SELECT d.id, d.name, d.code,
              coalesce(json_agg(json_build_object('id', t.id, 'name', t.name, 'is_field_crew', t.is_field_crew) ORDER BY t.name)
                       FILTER (WHERE t.id IS NOT NULL), '[]') AS teams
         FROM departments d LEFT JOIN teams t ON t.department_id = d.id AND t.is_active
        WHERE d.is_active GROUP BY d.id ORDER BY d.name`,
    ),
  );
  res.json(rows);
});

// GET /meta/wards — boundaries as GeoJSON for map overlays and filters
metaRouter.get('/wards', async (_req, res) => {
  const rows = await withTx(null, (db) =>
    many(db, `SELECT id, name, code, ST_AsGeoJSON(ST_SimplifyPreserveTopology(boundary, 0.0001), 6)::json AS boundary FROM wards ORDER BY name`),
  );
  res.json(rows);
});

metaRouter.get('/faq', async (_req, res) => {
  res.json(await withTx(null, (db) => many(db, 'SELECT id, question, answer, category_id FROM faq_articles WHERE is_published ORDER BY sort_order')));
});

metaRouter.get('/feedback-tags', async (_req, res) => {
  res.json(await withTx(null, (db) => many(db, 'SELECT code, label, is_positive FROM feedback_tags ORDER BY sort_order')));
});

// GET /meta/workflow — the allowed status moves, so UIs only offer legal buttons
metaRouter.get('/workflow', async (_req, res) => {
  res.json(await withTx(null, (db) => many(db, 'SELECT from_status, to_status, allowed_roles, description FROM incident_status_transitions ORDER BY from_status, to_status')));
});

export async function healthCheck() {
  const r = await pool.query('SELECT 1 AS ok, postgis_lib_version() AS postgis');
  return { status: 'ok', database: 'ok', postgis: r.rows[0].postgis, time: new Date().toISOString() };
}
