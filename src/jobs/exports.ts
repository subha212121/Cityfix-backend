import PDFDocument from 'pdfkit';
import { many, one, withTx, type Db } from '../db/pool.js';
import { putObject } from '../lib/storage.js';
import { notify } from '../services/notify.js';

type Filters = { from?: string; to?: string; department_id?: number; ward_id?: number; category_id?: number };

const TITLES: Record<string, string> = {
  incident_list: 'Incident list',
  incident_summary: 'Incident summary by category',
  sla_performance: 'SLA performance by department',
  category_trends: 'Category trends by month',
  department_workload: 'Department workload',
  citizen_satisfaction: 'Citizen satisfaction',
  ai_accuracy: 'AI accuracy (accepted vs overridden)',
  audit_log: 'Audit log',
};

/** SQL for each report; $1/$2 = date range, $3 department, $4 ward, $5 category. */
const WHERE = `i.created_at >= coalesce($1, '-infinity'::timestamptz) AND i.created_at < coalesce($2, 'infinity'::timestamptz)
  AND ($3::smallint IS NULL OR i.assigned_department_id = $3) AND ($4::smallint IS NULL OR i.ward_id = $4)
  AND ($5::smallint IS NULL OR i.category_id = $5 OR c.parent_id = $5) AND i.deleted_at IS NULL`;

const QUERIES: Record<string, string> = {
  incident_list: `
    SELECT i.reference_no AS incident_no, i.title, coalesce(p.name, c.name) AS category, c.name AS subcategory, i.priority, i.status,
           w.name AS ward, d.name AS department, t.name AS team, to_char(i.created_at, 'YYYY-MM-DD HH24:MI') AS reported,
           to_char(i.sla_due_at, 'YYYY-MM-DD') AS sla_due, to_char(i.resolved_at, 'YYYY-MM-DD') AS resolved
      FROM incidents i JOIN categories c ON c.id = i.category_id LEFT JOIN categories p ON p.id = c.parent_id
      LEFT JOIN wards w ON w.id = i.ward_id LEFT JOIN departments d ON d.id = i.assigned_department_id LEFT JOIN teams t ON t.id = i.assigned_team_id
     WHERE ${WHERE} ORDER BY i.created_at DESC`,
  incident_summary: `
    SELECT coalesce(p.name, c.name) AS category, count(*) AS received,
           count(*) FILTER (WHERE i.status IN ('resolved','closed') AND i.closure_reason IS DISTINCT FROM 'duplicate') AS resolved,
           count(*) FILTER (WHERE i.status NOT IN ('resolved','closed','rejected')) AS open,
           round(avg(extract(epoch FROM i.resolved_at - i.created_at) / 86400)::numeric, 1) AS avg_days
      FROM incidents i JOIN categories c ON c.id = i.category_id LEFT JOIN categories p ON p.id = c.parent_id
     WHERE ${WHERE} GROUP BY 1 ORDER BY received DESC`,
  sla_performance: `
    SELECT d.name AS department, count(*) FILTER (WHERE i.resolved_at IS NOT NULL) AS resolved,
           count(*) FILTER (WHERE i.resolved_at <= i.sla_due_at) AS within_sla,
           round(100.0 * count(*) FILTER (WHERE i.resolved_at <= i.sla_due_at) / nullif(count(*) FILTER (WHERE i.resolved_at IS NOT NULL), 0), 1) AS within_sla_pct,
           count(*) FILTER (WHERE i.resolved_at IS NULL AND i.sla_due_at < now() AND i.status NOT IN ('closed','rejected')) AS overdue_open,
           round(avg(extract(epoch FROM i.resolved_at - i.created_at) / 86400)::numeric, 1) AS avg_days
      FROM incidents i JOIN categories c ON c.id = i.category_id JOIN departments d ON d.id = i.assigned_department_id
     WHERE ${WHERE} GROUP BY 1 ORDER BY 1`,
  category_trends: `
    SELECT to_char(date_trunc('month', i.created_at), 'YYYY-MM') AS month, coalesce(p.name, c.name) AS category, count(*) AS reports
      FROM incidents i JOIN categories c ON c.id = i.category_id LEFT JOIN categories p ON p.id = c.parent_id
     WHERE ${WHERE} GROUP BY 1, 2 ORDER BY 1, 3 DESC`,
  department_workload: `
    SELECT department, officer, open_assigned, overdue, resolved_30d, max_open_assignments FROM v_department_workload
     WHERE ($3::smallint IS NULL OR department_id = $3) AND $1::timestamptz IS NOT DISTINCT FROM $1 AND $2::timestamptz IS NOT DISTINCT FROM $2
       AND $4::smallint IS NOT DISTINCT FROM $4 AND $5::smallint IS NOT DISTINCT FROM $5
     ORDER BY department, open_assigned DESC`,
  citizen_satisfaction: `
    SELECT coalesce(p.name, c.name) AS category, count(r.id) AS ratings, round(avg(r.score)::numeric, 2) AS avg_score,
           count(*) FILTER (WHERE r.requested_reopen) AS reopen_requests
      FROM incident_ratings r JOIN incidents i ON i.id = r.incident_id JOIN categories c ON c.id = i.category_id
      LEFT JOIN categories p ON p.id = c.parent_id
     WHERE ${WHERE} GROUP BY 1 ORDER BY ratings DESC`,
  ai_accuracy: `
    SELECT feature, to_char(month, 'YYYY-MM') AS month, predictions, failures, kept, overridden, kept_pct FROM v_ai_accuracy
     WHERE month >= date_trunc('month', coalesce($1, '-infinity'::timestamptz)) AND month < coalesce($2, 'infinity'::timestamptz)
       AND $3::smallint IS NOT DISTINCT FROM $3 AND $4::smallint IS NOT DISTINCT FROM $4 AND $5::smallint IS NOT DISTINCT FROM $5
     ORDER BY month, feature`,
  audit_log: `
    SELECT to_char(l.created_at, 'YYYY-MM-DD HH24:MI:SS') AS time, coalesce(u.full_name, 'System') AS actor, l.action,
           l.entity_type, l.entity_id, l.before_data::text AS before, l.after_data::text AS after
      FROM audit_logs l LEFT JOIN users u ON u.id = l.actor_id
     WHERE l.created_at >= coalesce($1, '-infinity'::timestamptz) AND l.created_at < coalesce($2, 'infinity'::timestamptz)
       AND $3::smallint IS NOT DISTINCT FROM $3 AND $4::smallint IS NOT DISTINCT FROM $4 AND $5::smallint IS NOT DISTINCT FROM $5
     ORDER BY l.created_at DESC LIMIT 50000`,
};

export function toCsv(rows: Record<string, unknown>[]) {
  if (!rows.length) return 'no rows\n';
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return '';
    let s = v instanceof Date ? v.toISOString() : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

function toPdf(title: string, filters: Filters, rows: Record<string, unknown>[]): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.fontSize(16).text(`CityFix – ${title}`);
    doc.fontSize(9).fillColor('#555').text(`Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · Filters: ${JSON.stringify(filters)} · ${rows.length} rows`);
    doc.moveDown();
    if (rows.length) {
      const cols = Object.keys(rows[0]).slice(0, 10);
      const width = (doc.page.width - 72) / cols.length;
      const line = (vals: string[], bold = false) => {
        const y = doc.y;
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor('#000');
        vals.forEach((v, i) => doc.text(v.slice(0, 40), 36 + i * width, y, { width: width - 4, lineBreak: false }));
        doc.moveDown(0.6);
        if (doc.y > doc.page.height - 50) doc.addPage();
      };
      line(cols, true);
      for (const r of rows.slice(0, 2000)) line(cols.map((c) => (r[c] === null || r[c] === undefined ? '' : String(r[c]))));
    }
    doc.end();
  });
}

/** Processes queued export jobs (called by the worker). */
export async function runExportJobs(limit = 5) {
  for (let i = 0; i < limit; i++) {
    const job = await withTx(null, (db) =>
      one(db, `UPDATE export_jobs SET status = 'running' WHERE id = (SELECT id FROM export_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`),
    );
    if (!job) return;
    try {
      const f: Filters = job.filters ?? {};
      const rows = await withTx(null, (db: Db) =>
        many(db, QUERIES[job.report_type], [f.from ?? null, f.to ?? null, f.department_id ?? null, f.ward_id ?? null, f.category_id ?? null]),
      );
      const key = `exports/${job.id}.${job.format}`;
      if (job.format === 'csv') await putObject(key, toCsv(rows), 'text/csv; charset=utf-8');
      else await putObject(key, await toPdf(TITLES[job.report_type], f, rows), 'application/pdf');
      await withTx(null, async (db) => {
        await db.query(`UPDATE export_jobs SET status = 'done', file_key = $2, row_count = $3, completed_at = now(), expires_at = now() + interval '7 days' WHERE id = $1`, [job.id, key, rows.length]);
        await notify(db, job.requested_by, 'export_ready', `Your ${TITLES[job.report_type]} export is ready`, `${rows.length} rows · ${job.format.toUpperCase()}`, null, { export_id: job.id });
      });
    } catch (err: any) {
      await withTx(null, (db) => db.query(`UPDATE export_jobs SET status = 'failed', error_message = $2, completed_at = now() WHERE id = $1`, [job.id, String(err?.message ?? err).slice(0, 500)]));
    }
  }
}
