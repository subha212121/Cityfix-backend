/**
 * Synthetic Smart City dataset (the brief allows synthetic data for analytics,
 * testing and AI evaluation). Creates citizens, officers and incidents spread
 * over the wards and the last N months, walks each incident through the real
 * status workflow (so triggers write history and audit rows), then back-dates
 * the timestamps so dashboards, SLA figures and heatmaps look realistic.
 *
 * Usage: DATABASE_ADMIN_URL=... npm run db:synthetic -- --incidents 3000 --months 6 --seed 42
 * Every generated row is tagged: emails end with @synthetic.example.
 */
import 'dotenv/config';
import pg from 'pg';

const arg = (name: string, def: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : def;
};
const RUN = Date.now().toString(36);
const N = arg('incidents', 2000);
const MONTHS = arg('months', 6);
let seed = arg('seed', 42);
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
const between = (a: number, b: number) => a + rand() * (b - a);

// Report text templates per subcategory (also a labelled set for AI accuracy testing)
const TEMPLATES: Record<string, { titles: string[]; texts: string[]; priority: string[] }> = {
  'road-pothole': { titles: ['Pothole on {st}', 'Deep pothole near {st}'], texts: ['Large pothole in the left lane on {st}. Cars are swerving around it.', 'There is a pothole about 50cm wide outside number {n}, {st}.'], priority: ['high', 'medium', 'medium'] },
  'road-surface': { titles: ['Road surface breaking up on {st}'], texts: ['The bitumen is cracking and breaking up along {st}.'], priority: ['medium', 'low'] },
  'road-footpath': { titles: ['Uneven footpath on {st}'], texts: ['Raised footpath slab outside {n} {st} is a trip hazard for older people.'], priority: ['medium', 'high'] },
  'waste-dumping': { titles: ['Illegal dumping on {st}', 'Mattress dumped at {st}'], texts: ['Someone dumped a mattress and old furniture on the nature strip at {st}.', 'Pile of rubbish bags dumped behind the shops on {st}.'], priority: ['medium', 'low'] },
  'waste-bin': { titles: ['Overflowing bin at {st} bus stop'], texts: ['The public bin at the bus stop on {st} is overflowing and litter is blowing onto the road.'], priority: ['low', 'medium'] },
  'waste-missed': { titles: ['Missed bin collection {st}'], texts: ['Our red bin was not collected on {st} this week.'], priority: ['low'] },
  'traffic-signal': { titles: ['Traffic lights out at {st}'], texts: ['The traffic lights at {st} and Main Rd are not working. Cars are not sure who has right of way.'], priority: ['critical', 'high'] },
  'traffic-sign': { titles: ['Stop sign knocked over on {st}'], texts: ['The stop sign at the corner of {st} has been knocked over.'], priority: ['high', 'medium'] },
  'traffic-congestion': { titles: ['Traffic congestion on {st}'], texts: ['Large pothole causing traffic congestion on {st} every morning.', 'Roadworks cones left blocking a lane on {st}, causing congestion.'], priority: ['medium', 'high'] },
  'traffic-parking': { titles: ['Car parked across driveway {st}'], texts: ['A car has been parked across my driveway on {st} for two days.'], priority: ['low', 'medium'] },
  'safety-graffiti': { titles: ['Graffiti on {st} bus shelter', 'Graffiti tags on {st} wall'], texts: ['Graffiti spray painted on the bus shelter on {st}.', 'New graffiti tags along the wall of the community centre on {st}.'], priority: ['low'] },
  'safety-vandalism': { titles: ['Smashed bus shelter glass {st}'], texts: ['Broken glass from the smashed bus shelter on {st} is all over the footpath.'], priority: ['high', 'medium'] },
  'safety-hazard': { titles: ['Exposed wires near {st} playground'], texts: ['There are exposed wires hanging from a pole near the playground on {st}. It looks dangerous.'], priority: ['critical', 'high'] },
  'safety-vehicle': { titles: ['Abandoned car on {st}'], texts: ['A car with no plates has been abandoned on {st} for three weeks.'], priority: ['low', 'medium'] },
  'enviro-tree': { titles: ['Fallen tree on {st}', 'Large branch down on {st}'], texts: ['A large branch has fallen across the footpath on {st} after last night\'s storm.'], priority: ['high', 'medium'] },
  'enviro-pollution': { titles: ['Oil spill in creek near {st}'], texts: ['There is an oily film and a strong smell in the creek behind {st}.'], priority: ['high', 'critical'] },
  'enviro-noise': { titles: ['Loud noise from site on {st}'], texts: ['Construction noise on {st} starts before 6am every day.'], priority: ['low', 'medium'] },
  'enviro-park': { titles: ['Broken swing at {st} park'], texts: ['One of the swings at the playground on {st} is broken and hanging by one chain.'], priority: ['medium', 'high'] },
  'util-streetlight': { titles: ['Streetlight out on {st}', 'Street light not working {st}'], texts: ['The street light outside {n} {st} has been out for a week. The street is very dark at night.'], priority: ['medium', 'high'] },
  'util-water-leak': { titles: ['Water leak on {st}', 'Burst water main {st}'], texts: ['Water is leaking from a burst pipe under the road on {st}.'], priority: ['high', 'critical'] },
  'util-drain': { titles: ['Blocked drain on {st}'], texts: ['The stormwater drain on {st} is blocked with leaves and the road floods when it rains.'], priority: ['medium', 'high'] },
  'util-asset': { titles: ['Missing pit lid on {st}'], texts: ['A pit lid is missing on the footpath at {st}, leaving an open hole.'], priority: ['high', 'critical'] },
};
const STREETS = ['Smith St', 'King St', 'Park Ave', 'Hill Rd', 'George St', 'Church St', 'Station Rd', 'Victoria Rd', 'Pitt St', 'Bridge Rd', 'Elizabeth St', 'Oxford St', 'Railway Pde', 'High St', 'Wattle Ave'];
// Weighted slugs: more potholes, dumping and streetlights, as real councils see
const WEIGHTS: [string, number][] = Object.keys(TEMPLATES).map((s) => [s, /pothole|dumping|streetlight|graffiti|bin/.test(s) ? 3 : 1]);
const weightedSlug = () => {
  const total = WEIGHTS.reduce((a, [, w]) => a + w, 0);
  let r = rand() * total;
  for (const [s, w] of WEIGHTS) if ((r -= w) <= 0) return s;
  return WEIGHTS[0][0];
};
// Hotspots inside the sample wards (lng, lat)
const HOTSPOTS = [[151.205, -33.86], [151.225, -33.885], [151.255, -33.87], [151.16, -33.875], [151.21, -33.893]];

const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await client.connect();
const q = (sql: string, p: unknown[] = []) => client.query(sql, p);

const cats = new Map<string, number>((await q('SELECT slug, id FROM categories')).rows.map((r) => [r.slug, r.id]));
const teams = (await q('SELECT t.id, t.department_id FROM teams t')).rows;

console.log(`creating ${Math.ceil(N / 4)} citizens and 12 officers ...`);
await q('BEGIN');
const citizens: string[] = [];
for (let i = 0; i < Math.ceil(N / 4); i++) {
  const r = await q(`INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at, created_at)
                     VALUES ($1, NULL, $2, 'citizen', 'pending', NULL, now() - make_interval(days => $3)) RETURNING id`,
    [`citizen${i}.${RUN}@synthetic.example`, `Citizen ${i}`, Math.floor(between(1, MONTHS * 30))]);
  await q('INSERT INTO citizen_profiles (user_id) VALUES ($1)', [r.rows[0].id]);
  citizens.push(r.rows[0].id);
}
const officers: { id: string; dept: number; team: number }[] = [];
const depts = (await q(`SELECT id FROM departments WHERE code <> 'IT'`)).rows.map((r) => r.id);
for (let i = 0; i < 12; i++) {
  const dept = depts[i % depts.length];
  const team = teams.find((t) => t.department_id === dept)!.id;
  const r = await q(`INSERT INTO users (email, full_name, role, status) VALUES ($1, $2, 'officer', 'pending') RETURNING id`, [`officer${i}.${RUN}@synthetic.example`, `Officer ${i}`]);
  await q('INSERT INTO officer_profiles (user_id, employee_no, department_id, team_id, is_supervisor) VALUES ($1, $2, $3, $4, $5)', [r.rows[0].id, `SYN-${RUN}-${i}`, dept, team, i < depts.length]);
  officers.push({ id: r.rows[0].id, dept, team });
}
await q('COMMIT');

console.log(`creating ${N} incidents over ${MONTHS} months ...`);
const FLOW = ['under_review', 'assigned', 'in_progress', 'resolved', 'closed'];
for (let i = 0; i < N; i++) {
  const slug = weightedSlug();
  const t = TEMPLATES[slug];
  const st = pick(STREETS);
  const fill = (s: string) => s.replace('{st}', st).replace('{n}', String(Math.floor(between(1, 200))));
  const [hx, hy] = rand() < 0.6 ? pick(HOTSPOTS) : [between(151.15, 151.27), between(-33.895, -33.845)];
  const lng = hx + between(-0.006, 0.006);
  const lat = hy + between(-0.004, 0.004);
  const ageDays = between(0, MONTHS * 30);
  const created = new Date(Date.now() - ageDays * 864e5);
  const priority = pick(t.priority);

  // Older incidents are further along the workflow
  const progress = Math.min(FLOW.length, Math.floor((ageDays / 10) * between(0.3, 1.6)));
  const rejected = rand() < 0.03;

  await q('BEGIN');
  await q(`SELECT set_config('app.role', '', true)`);
  const inc = (await q(
    `INSERT INTO incidents (title, description, reporter_id, location, category_id, category_source, priority, priority_source,
                            ai_category_id, ai_priority, ai_confidence, created_at, occurred_at, is_anonymous)
     VALUES ($1, $2, $3, ST_MakePoint($4, $5)::geography, $6, 'ai', $7, 'ai', $6, $7, $8, $9, $9, $10) RETURNING id, assigned_department_id`,
    [fill(pick(t.titles)), fill(pick(t.texts)), pick(citizens), lng, lat, cats.get(slug), priority, between(0.6, 0.97), created, rand() < 0.1],
  )).rows[0];

  const stamps: Date[] = [created];
  let at = created.getTime();
  const steps = rejected ? ['rejected'] : FLOW.slice(0, progress);
  for (const s of steps) {
    at += between(0.05, s === 'resolved' ? 2.5 : 0.7) * 864e5;
    if (at > Date.now()) break;
    const officer = officers.find((o) => o.dept === inc.assigned_department_id) ?? pick(officers);
    const extra =
      s === 'assigned' ? `, assigned_team_id = ${officer.team}, assigned_officer_id = '${officer.id}'`
      : s === 'rejected' ? `, closure_reason = 'invalid'`
      : s === 'closed' ? `, closure_reason = '${rand() < 0.6 ? 'confirmed_by_citizen' : 'auto_closed'}'`
      : '';
    await q(`UPDATE incidents SET status = $2${extra} WHERE id = $1`, [inc.id, s]);
    stamps.push(new Date(at));
    if (s === 'resolved' && rand() < 0.55) {
      await q('INSERT INTO incident_ratings (incident_id, citizen_id, score, created_at) SELECT id, reporter_id, $2, $3 FROM incidents WHERE id = $1',
        [inc.id, Math.max(1, Math.min(5, Math.round(between(2.5, 5.8)))), new Date(at + 864e5)]);
    }
  }
  // Back-date the workflow timestamps and history to the simulated times
  const ts = (k: number) => stamps[k] ?? null;
  await q(
    `UPDATE incidents SET updated_at = $2::timestamptz,
            first_reviewed_at = CASE WHEN first_reviewed_at IS NOT NULL THEN $3::timestamptz END,
            assigned_at = CASE WHEN assigned_at IS NOT NULL THEN $4::timestamptz END,
            work_started_at = CASE WHEN work_started_at IS NOT NULL THEN $5::timestamptz END,
            resolved_at = CASE WHEN resolved_at IS NOT NULL THEN $6::timestamptz END,
            closed_at = CASE WHEN closed_at IS NOT NULL THEN coalesce($7::timestamptz, $3::timestamptz) END
      WHERE id = $1`,
    [inc.id, stamps.at(-1), ts(1), ts(2), ts(3), ts(4), ts(5)],
  );
  await q(
    `UPDATE incident_status_history h SET created_at = ($2::timestamptz[])[x.rn]
       FROM (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM incident_status_history WHERE incident_id = $1) x
      WHERE h.id = x.id AND ($2::timestamptz[])[x.rn] IS NOT NULL`,
    [inc.id, stamps],
  );
  await q(`INSERT INTO ai_predictions (feature, incident_id, model_name, suggested_category_id, suggested_priority, confidence, run_status, decision, final_category_id, final_priority, created_at)
           VALUES ('categorize', $1, 'synthetic', $2, $3, 0.8, 'success', $4, $2, $3, $5)`,
    [inc.id, cats.get(slug), priority, rand() < 0.85 ? 'accepted' : 'overridden', created]);
  await q('COMMIT');
  if ((i + 1) % 250 === 0) console.log(`  ${i + 1}/${N}`);
}

await q('SELECT refresh_incident_stats()');
const s = (await q(`SELECT count(*) AS n, count(*) FILTER (WHERE status = 'closed') AS closed FROM incidents`)).rows[0];
console.log(`done: ${s.n} incidents in the database (${s.closed} closed). Synthetic users have no password and cannot sign in.`);
await client.end();
