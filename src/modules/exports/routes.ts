import { Router } from 'express';
import { z } from 'zod';
import { many, one, withTx } from '../../db/pool.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { actorOf, UuidParam } from '../../lib/http.js';
import { presignDownload } from '../../lib/storage.js';
import { requireAuth, staffOnly } from '../../middleware/auth.js';

export const exportsRouter = Router();
exportsRouter.use(requireAuth, staffOnly);

export const REPORT_TYPES = [
  'incident_list', 'incident_summary', 'sla_performance', 'category_trends',
  'department_workload', 'citizen_satisfaction', 'ai_accuracy', 'audit_log',
] as const;
const OFFICER_REPORTS = new Set(['incident_list', 'incident_summary', 'sla_performance', 'department_workload']);

// POST /exports — "Generate reports" (officer) / "Produce performance reports" (admin), FR-24, A8
exportsRouter.post('/', async (req, res) => {
  const a = actorOf(req);
  const b = z
    .object({
      report_type: z.enum(REPORT_TYPES),
      format: z.enum(['csv', 'pdf']),
      filters: z
        .object({
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
          department_id: z.number().int().optional(),
          ward_id: z.number().int().optional(),
          category_id: z.number().int().optional(),
        })
        .default({}),
    })
    .parse(req.body);
  if (a.role === 'officer' && !OFFICER_REPORTS.has(b.report_type)) throw forbidden('Officers can export incident lists, summaries, SLA and workload reports');
  const job = await withTx(a, (db) =>
    one(db, `INSERT INTO export_jobs (requested_by, report_type, filters, format) VALUES ($1, $2, $3, $4) RETURNING id, report_type, format, status, created_at`, [
      a.userId, b.report_type, JSON.stringify(b.filters), b.format,
    ]),
  );
  res.status(202).json(job);
});

// GET /exports — recent exports (A8 "Recent exports")
exportsRouter.get('/', async (req, res) => {
  const a = actorOf(req);
  res.json(
    await withTx(a, (db) =>
      many(
        db,
        `SELECT e.id, e.report_type, e.format, e.status, e.row_count, e.created_at, e.completed_at, u.full_name AS created_by
           FROM export_jobs e JOIN users u ON u.id = e.requested_by
          WHERE e.requested_by = $1 OR $2 = 'admin' ORDER BY e.created_at DESC LIMIT 50`,
        [a.userId, a.role],
      ),
    ),
  );
});

// GET /exports/:id — status + download link when done
exportsRouter.get('/:id', async (req, res) => {
  const a = actorOf(req);
  const { id } = UuidParam.parse(req.params);
  const e = await withTx(a, (db) => one(db, 'SELECT * FROM export_jobs WHERE id = $1 AND (requested_by = $2 OR $3 = \'admin\')', [id, a.userId, a.role]));
  if (!e) throw notFound('Export');
  res.json({ ...e, download_url: e.status === 'done' && e.file_key ? await presignDownload(e.file_key, 3600) : null });
});
