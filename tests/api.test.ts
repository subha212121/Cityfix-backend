/**
 * End-to-end API tests: the brief's main workflow from sign-up to closed
 * incident, plus permissions, AI fallback, chatbot, dashboards, admin and jobs.
 * Runs against a real PostgreSQL + PostGIS database (see global-setup.ts).
 */
import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';

const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/db/pool.js');
const { sentMail } = await import('../src/lib/mailer.js');
const { setProvider } = await import('../src/ai/provider.js');
const jobs = await import('../src/jobs/index.js');

const app = createApp();
const api = () => request(app);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

const state: Record<string, any> = {};

async function signUpCitizen(email: string, name: string) {
  const reg = await api().post('/api/v1/auth/register').send({ email, password: 'Secret123', full_name: name, accept_terms: true });
  expect(reg.status).toBe(201);
  await api().post('/api/v1/auth/verify-email').send({ token: reg.body.dev_token }).expect(200);
  const login = await api().post('/api/v1/auth/login').send({ email, password: 'Secret123' }).expect(200);
  return { id: reg.body.id as string, token: login.body.access_token as string, refresh: login.body.refresh_token as string };
}

afterAll(async () => {
  await pool.end();
});

describe('health and reference data', () => {
  it('reports database and PostGIS', async () => {
    const r = await api().get('/health').expect(200);
    expect(r.body.database).toBe('ok');
    expect(r.body.postgis).toMatch(/^3\./);
  });

  it('serves the six brief categories with subcategories', async () => {
    const r = await api().get('/api/v1/meta/categories').expect(200);
    expect(r.body.map((c: any) => c.name)).toEqual([
      'Road Maintenance', 'Waste Management', 'Traffic Management', 'Public Safety', 'Environmental Issues', 'Utilities and Infrastructure',
    ]);
    expect(r.body[0].subcategories.length).toBeGreaterThan(0);
  });
});

describe('authentication (FR-01 … FR-04)', () => {
  it('blocks sign-in until the email is verified', async () => {
    const reg = await api().post('/api/v1/auth/register').send({ email: 'pending@mail.example', password: 'Secret123', full_name: 'Pen Ding', accept_terms: true });
    expect(reg.status).toBe(201);
    const r = await api().post('/api/v1/auth/login').send({ email: 'pending@mail.example', password: 'Secret123' });
    expect(r.status).toBe(403);
  });

  it('rejects weak passwords and duplicate emails', async () => {
    await api().post('/api/v1/auth/register').send({ email: 'weak@mail.example', password: 'short', full_name: 'Weak', accept_terms: true }).expect(400);
    await api().post('/api/v1/auth/register').send({ email: 'PENDING@mail.example', password: 'Secret123', full_name: 'Dup', accept_terms: true }).expect(409);
  });

  it('registers, verifies and signs in citizens', async () => {
    state.c1 = await signUpCitizen('r.resident@mail.example', 'R. Resident');
    state.c2 = await signUpCitizen('t.resident@mail.example', 'T. Resident');
    const me = await api().get('/api/v1/me').set(auth(state.c1.token)).expect(200);
    expect(me.body.role).toBe('citizen');
    expect(sentMail.some((m) => m.subject.includes('Confirm your CityFix account'))).toBe(true);
  });

  it('rotates refresh tokens and rejects reuse', async () => {
    const r = await api().post('/api/v1/auth/refresh').send({ refresh_token: state.c1.refresh }).expect(200);
    expect(r.body.refresh_token).not.toBe(state.c1.refresh);
    await api().post('/api/v1/auth/refresh').send({ refresh_token: state.c1.refresh }).expect(401);
    state.c1.token = r.body.access_token;
  });

  it('signs in the seeded admin and upgrades the bcrypt hash', async () => {
    const r = await api().post('/api/v1/auth/login').send({ email: 'admin@council.example', password: 'ChangeMe!2026' }).expect(200);
    state.admin = { token: r.body.access_token, id: r.body.user.id };
    const { rows } = await pool.query(`SELECT password_hash FROM users WHERE email = 'admin@council.example'`);
    expect(rows[0].password_hash.startsWith('$argon2id$')).toBe(true);
  });

  it('invites an officer who accepts and signs in (officer profile created)', async () => {
    const depts = await api().get('/api/v1/meta/departments').expect(200);
    const roads = depts.body.find((d: any) => d.code === 'ROADS');
    const crew = roads.teams.find((t: any) => t.name === 'Roads crew B');
    state.roads = roads;
    state.crewB = crew;
    const inv = await api().post('/api/v1/admin/invitations').set(auth(state.admin.token))
      .send({ email: 'j.officer@council.example', role: 'officer', employee_no: 'EMP-1001', department_id: roads.id, team_id: crew.id }).expect(201);
    await api().post('/api/v1/auth/accept-invite').send({ token: inv.body.dev_token, full_name: 'J. Officer', password: 'Officer123' }).expect(201);
    const login = await api().post('/api/v1/auth/login').send({ email: 'j.officer@council.example', password: 'Officer123' }).expect(200);
    state.officer = { token: login.body.access_token, id: login.body.user.id };
    const me = await api().get('/api/v1/me').set(auth(state.officer.token)).expect(200);
    expect(me.body.department).toBe('Roads maintenance');
    expect(me.body.employee_no).toBe('EMP-1001');
  });

  it('locks an account after 5 wrong passwords', async () => {
    await signUpCitizen('lock@mail.example', 'Lock Me');
    for (let i = 0; i < 5; i++) await api().post('/api/v1/auth/login').send({ email: 'lock@mail.example', password: 'Wrong1234' }).expect(401);
    await api().post('/api/v1/auth/login').send({ email: 'lock@mail.example', password: 'Secret123' }).expect(423);
  });

  it('resets a forgotten password', async () => {
    const f = await api().post('/api/v1/auth/forgot-password').send({ email: 't.resident@mail.example' }).expect(202);
    await api().post('/api/v1/auth/reset-password').send({ token: f.body.dev_token, password: 'NewSecret456' }).expect(200);
    const l = await api().post('/api/v1/auth/login').send({ email: 't.resident@mail.example', password: 'NewSecret456' }).expect(200);
    state.c2.token = l.body.access_token;
  });
});

describe('incident reporting with AI (FR-05 … FR-08, FR-25/26)', () => {
  it('suggests Road Maintenance for the brief\'s example (keyword fallback, AI off)', async () => {
    const r = await api().post('/api/v1/ai/suggest').set(auth(state.c1.token))
      .send({ description: 'Large pothole causing traffic congestion.' }).expect(200);
    expect(r.body.source).toBe('fallback');
    expect(r.body.category.parent_name).toBe('Road Maintenance');
    expect(r.body.category.name).toBe('Pothole');
    state.prediction = r.body.prediction_id;
  });

  it('uses the AI provider when configured and validates its answer', async () => {
    const { rows } = await pool.query(`SELECT id FROM categories WHERE slug = 'util-streetlight'`);
    setProvider({ name: 'openai', model: 'fake-model', json: async () => ({ data: { category_id: rows[0].id, priority: 'high', reason: 'Dark street at night is a safety risk', confidence: 0.91 }, model: 'fake-model' }) });
    const ok = await api().post('/api/v1/ai/suggest').set(auth(state.c1.token)).send({ description: 'The light on our corner has been out all week' }).expect(200);
    expect(ok.body).toMatchObject({ source: 'ai', priority: 'high', category_id: rows[0].id, ai_available: true });

    setProvider({ name: 'openai', model: 'fake-model', json: async () => ({ data: { category_id: 999999, priority: 'urgent' }, model: 'fake-model' }) });
    const bad = await api().post('/api/v1/ai/suggest').set(auth(state.c1.token)).send({ description: 'Overflowing bin near the bus stop' }).expect(200);
    expect(bad.body.source).toBe('fallback');

    setProvider({ name: 'openai', model: 'fake-model', json: async () => { throw new Error('Request timed out'); } });
    const down = await api().post('/api/v1/ai/suggest').set(auth(state.c1.token)).send({ description: 'Graffiti on the library wall' }).expect(200);
    expect(down.body).toMatchObject({ source: 'fallback', ai_available: false });
    const { rows: runs } = await pool.query(`SELECT run_status FROM ai_predictions ORDER BY id DESC LIMIT 1`);
    expect(runs[0].run_status).toBe('timeout');
    setProvider(null);
  });

  it('presigns a photo upload only for JPG/PNG up to 5 MB', async () => {
    await api().post('/api/v1/uploads/presign').set(auth(state.c1.token)).send({ mime_type: 'image/gif', size_bytes: 1000 }).expect(400);
    await api().post('/api/v1/uploads/presign').set(auth(state.c1.token)).send({ mime_type: 'image/jpeg', size_bytes: 6 * 1024 * 1024 }).expect(400);
    const r = await api().post('/api/v1/uploads/presign').set(auth(state.c1.token)).send({ mime_type: 'image/jpeg', size_bytes: 900_000 }).expect(201);
    expect(r.body.storage_key).toMatch(new RegExp(`^uploads/${state.c1.id}/`));
    expect(r.body.upload_url).toContain('/api/v1/files/upload/');
    state.photoKey = r.body.storage_key;
    state.uploadPath = new URL(r.body.upload_url).pathname;
  });

  it('stores the photo in the local folder via the signed upload URL', async () => {
    const fake = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);
    await api().put(state.uploadPath).set('Content-Type', 'image/png').send(fake).expect(415);          // wrong type
    await api().put(state.uploadPath).set('Content-Type', 'image/jpeg').send(Buffer.from('not an image')).expect(415);
    await api().put('/api/v1/files/upload/not-a-token').set('Content-Type', 'image/jpeg').send(fake).expect(403);
    const ok = await api().put(state.uploadPath).set('Content-Type', 'image/jpeg').send(fake).expect(200);
    expect(ok.body.size_bytes).toBe(fake.length);
    state.photoBytes = fake;
  });

  it('creates an incident: number, ward, routing, SLA, photo, AI values kept', async () => {
    const r = await api().post('/api/v1/incidents').set(auth(state.c1.token)).send({
      title: 'Pothole on Smith St',
      description: 'Large pothole causing traffic congestion. Cars are swerving into the next lane.',
      lat: -33.86, lng: 151.2093, address: '14 Smith St',
      prediction_id: state.prediction,
      photos: [{ storage_key: state.photoKey, mime_type: 'image/jpeg', size_bytes: 900_000 }],
    }).expect(201);
    expect(r.body.reference_no).toMatch(/^INC-\d{4}-\d{5}$/);
    expect(r.body.ward).toBe('North ward');
    expect(r.body.top_category).toBe('Road Maintenance');
    expect(r.body.department).toBe('Roads maintenance');
    expect(r.body.category_source).toBe('ai');
    expect(r.body.priority).toBe('high');
    expect(r.body.photos).toHaveLength(1);
    expect(r.body.ai_confidence).toBeUndefined(); // internal AI fields hidden from citizens
    const photo = await api().get(new URL(r.body.photos[0].url).pathname).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(photo.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.compare(photo.body, state.photoBytes)).toBe(0);
    state.inc = r.body;
  });

  it('rejects a photo uploaded by someone else and bad coordinates', async () => {
    await api().post('/api/v1/incidents').set(auth(state.c2.token)).send({
      title: 'Test', description: 'Somebody else photo test', lat: -33.86, lng: 151.2, category_id: state.inc.category_id,
      photos: [{ storage_key: state.photoKey, mime_type: 'image/jpeg', size_bytes: 1000 }],
    }).expect(403);
    await api().post('/api/v1/incidents').set(auth(state.c2.token)).send({ title: 'Bad', description: 'Bad latitude here', lat: 200, lng: 151.2, category_id: state.inc.category_id }).expect(400);
  });

  it('flags a nearby duplicate when a second citizen reports the same pothole', async () => {
    const r = await api().post('/api/v1/incidents').set(auth(state.c2.token)).send({
      title: 'Hole in Smith Street', description: 'There is a big pothole near number 16, quite deep.', lat: -33.8601, lng: 151.2094, is_anonymous: true,
    }).expect(201);
    expect(r.body.possible_duplicates.map((d: any) => d.id)).toContain(state.inc.id);
    state.dup = r.body;
  });

  it('keeps private reports private between citizens (RLS)', async () => {
    const p = await api().post('/api/v1/incidents').set(auth(state.c2.token)).send({
      title: 'Noise from building site', description: 'Loud machinery before 7am every day this week.', lat: -33.88, lng: 151.25,
    }).expect(201);
    await pool.query('UPDATE incidents SET is_public = false WHERE id = $1', [p.body.id]);
    await api().get(`/api/v1/incidents/${p.body.id}`).set(auth(state.c1.token)).expect(404);
    await api().get(`/api/v1/incidents/${p.body.id}`).set(auth(state.c2.token)).expect(200);
    state.private = p.body;
  });

  it('lists "My reports" for the citizen only', async () => {
    const r = await api().get('/api/v1/incidents').set(auth(state.c1.token)).expect(200);
    expect(r.body.data.every((i: any) => i.id !== state.dup.id)).toBe(true);
    expect(r.body.total).toBe(1);
  });
});

describe('officer workflow (FR-10 … FR-14, FR-27, FR-28)', () => {
  it('stops citizens from triaging', async () => {
    await api().patch(`/api/v1/incidents/${state.inc.id}`).set(auth(state.c1.token)).send({ status: 'under_review' }).expect(403);
  });

  it('shows the work queue sorted by priority, anonymous reporter hidden', async () => {
    const r = await api().get('/api/v1/incidents').set(auth(state.officer.token)).expect(200);
    expect(r.body.data[0].priority).toBe('high');
    const dup = r.body.data.find((i: any) => i.id === state.dup.id);
    expect(dup.reporter).toBe('Anonymous citizen');
  });

  it('merges the duplicate into the main incident', async () => {
    const r = await api().post(`/api/v1/incidents/${state.dup.id}/merge`).set(auth(state.officer.token)).send({ into_id: state.inc.id }).expect(200);
    expect(r.body.merged_reports).toBe(1);
    expect(r.body.supporter_count).toBe(1);
  });

  it('refuses an illegal status jump', async () => {
    const r = await api().patch(`/api/v1/incidents/${state.inc.id}`).set(auth(state.officer.token)).send({ status: 'resolved' });
    expect(r.status).toBe(422);
  });

  it('reviews, overrides AI priority, assigns and works the incident', async () => {
    await api().patch(`/api/v1/incidents/${state.inc.id}`).set(auth(state.officer.token)).send({ status: 'under_review', note: 'Checking with the roads team' }).expect(200);
    const o = await api().patch(`/api/v1/incidents/${state.inc.id}`).set(auth(state.officer.token)).send({ priority: 'critical' }).expect(200);
    expect(o.body).toMatchObject({ priority: 'critical', ai_priority: 'high', priority_source: 'staff' });
    const a = await api().patch(`/api/v1/incidents/${state.inc.id}`).set(auth(state.officer.token))
      .send({ status: 'assigned', assigned_team_id: state.crewB.id, assigned_officer_id: state.officer.id, note: 'Crew booked for Thursday morning' }).expect(200);
    expect(a.body).toMatchObject({ status: 'assigned', team: 'Roads crew B', officer: 'J. Officer' });
    await api().patch(`/api/v1/incidents/${state.inc.id}`).set(auth(state.officer.token)).send({ status: 'in_progress' }).expect(200);
    const { rows } = await pool.query(`SELECT decision FROM ai_predictions WHERE incident_id = $1 AND feature = 'categorize'`, [state.inc.id]);
    expect(rows[0].decision).toBe('overridden');
  });

  it('exchanges messages; internal notes stay internal', async () => {
    await api().post(`/api/v1/incidents/${state.inc.id}/messages`).set(auth(state.officer.token)).send({ body: 'Is the hole in the left lane?' }).expect(201);
    await api().post(`/api/v1/incidents/${state.inc.id}/messages`).set(auth(state.officer.token)).send({ body: 'Needs traffic control', is_internal: true }).expect(201);
    await api().post(`/api/v1/incidents/${state.inc.id}/messages`).set(auth(state.c1.token)).send({ body: 'Yes, left lane.' }).expect(201);
    await api().post(`/api/v1/incidents/${state.inc.id}/messages`).set(auth(state.c1.token)).send({ body: 'x', is_internal: true }).expect(403);
    const c = await api().get(`/api/v1/incidents/${state.inc.id}/messages`).set(auth(state.c1.token)).expect(200);
    expect(c.body.map((m: any) => m.body)).toEqual(['Is the hole in the left lane?', 'Yes, left lane.']);
    const o = await api().get(`/api/v1/incidents/${state.inc.id}/messages`).set(auth(state.officer.token)).expect(200);
    expect(o.body).toHaveLength(3);
  });

  it('writes an AI summary of the merged reports (fallback when AI is off)', async () => {
    const r = await api().post(`/api/v1/incidents/${state.inc.id}/summary`).set(auth(state.officer.token)).expect(200);
    expect(r.body.ai_summary).toContain('2 citizen reports');
  });

  it('resolves; citizen reopens; resolves again; citizen confirms with a rating', async () => {
    await api().patch(`/api/v1/incidents/${state.inc.id}`).set(auth(state.officer.token)).send({ status: 'resolved', note: 'Pothole filled and sealed' }).expect(200);
    const re = await api().post(`/api/v1/incidents/${state.inc.id}/rating`).set(auth(state.c1.token)).send({ score: 2, tags: ['not_fully_fixed'], comment: 'Still a dip', reopen: true }).expect(201);
    expect(re.body).toMatchObject({ status: 'in_progress', reopen_count: 1 });
    await api().patch(`/api/v1/incidents/${state.inc.id}`).set(auth(state.officer.token)).send({ status: 'resolved', note: 'Resurfaced' }).expect(200);
    const ok = await api().post(`/api/v1/incidents/${state.inc.id}/rating`).set(auth(state.c1.token)).send({ score: 5, tags: ['fixed_quickly', 'kept_me_updated'] }).expect(201);
    expect(ok.body).toMatchObject({ status: 'closed', closure_reason: 'confirmed_by_citizen' });
    expect(ok.body.history.map((h: any) => h.to_status)).toEqual(
      ['new', 'under_review', 'assigned', 'in_progress', 'resolved', 'in_progress', 'resolved', 'closed'],
    );
  });

  it('notified the citizen at each step', async () => {
    const r = await api().get('/api/v1/notifications').set(auth(state.c1.token)).expect(200);
    const titles = r.body.data.map((n: any) => n.title).join(' | ');
    expect(titles).toContain('is in');
    expect(titles).toContain('Under Review');
    expect(titles).toContain('resolved – how did we do?');
    expect(titles).toContain('New message');
  });

  it('shows the feedback history', async () => {
    const r = await api().get('/api/v1/me/feedback-history').set(auth(state.c1.token)).expect(200);
    expect(r.body).toHaveLength(2);
    expect(r.body[0].tags).toEqual(['fixed_quickly', 'kept_me_updated']);
  });
});

describe('map (FR-17 … FR-19)', () => {
  it('returns pins with severity and open/resolved state inside a bounding box', async () => {
    const r = await api().get('/api/v1/map/incidents').query({ min_lat: -33.9, min_lng: 151.15, max_lat: -33.84, max_lng: 151.27 }).set(auth(state.c1.token)).expect(200);
    const pin = r.body.incidents.find((i: any) => i.id === state.inc.id);
    expect(pin).toMatchObject({ severity: 'critical', is_open: false, top_category: 'Road Maintenance' });
    expect(r.body.incidents.find((i: any) => i.id === state.private.id)).toBeUndefined();
    const open = await api().get('/api/v1/map/incidents').query({ min_lat: -33.9, min_lng: 151.15, max_lat: -33.84, max_lng: 151.27, state: 'open' }).set(auth(state.c1.token)).expect(200);
    expect(open.body.incidents.every((i: any) => i.is_open)).toBe(true);
  });

  it('serves the heatmap to staff only', async () => {
    await api().get('/api/v1/map/heatmap').set(auth(state.c1.token)).expect(403);
    const r = await api().get('/api/v1/map/heatmap').set(auth(state.admin.token)).expect(200);
    expect(r.body.cells.length).toBeGreaterThan(0);
  });
});

describe('chatbot (FR-29)', () => {
  it('answers FAQs, shows a status card from the database, and hands over to a person', async () => {
    const c = await api().post('/api/v1/chat/conversations').set(auth(state.c1.token)).send({}).expect(201);
    const faq = await api().post(`/api/v1/chat/conversations/${c.body.id}/messages`).set(auth(state.c1.token)).send({ body: 'Can I report anonymously?' }).expect(201);
    expect(faq.body.messages.at(-1).body).toContain('name is hidden');
    const st = await api().post(`/api/v1/chat/conversations/${c.body.id}/messages`).set(auth(state.c1.token)).send({ body: `Any update on ${state.inc.reference_no}?` }).expect(201);
    expect(st.body.messages.at(-1).payload).toMatchObject({ type: 'status_card', reference_no: state.inc.reference_no, status: 'closed' });
    const ho = await api().post(`/api/v1/chat/conversations/${c.body.id}/messages`).set(auth(state.c1.token)).send({ body: 'Can I talk to a person please' }).expect(201);
    expect(ho.body.action).toBe('handover');
    const inbox = await api().get('/api/v1/chat/handovers').set(auth(state.officer.token)).expect(200);
    expect(inbox.body.map((x: any) => x.id)).toContain(c.body.id);
    await api().post(`/api/v1/chat/conversations/${c.body.id}/messages`).set(auth(state.officer.token)).send({ body: 'Hi, J. here. How can I help?' }).expect(201);
    const conv = await api().get(`/api/v1/chat/conversations/${c.body.id}`).set(auth(state.c1.token)).expect(200);
    expect(conv.body.status).toBe('with_staff');
  });

  it('helps lodge a report by building a draft', async () => {
    const c = await api().post('/api/v1/chat/conversations').set(auth(state.c2.token)).send({}).expect(201);
    const r = await api().post(`/api/v1/chat/conversations/${c.body.id}/messages`).set(auth(state.c2.token)).send({ body: 'I want to report a broken traffic light on King St' }).expect(201);
    expect(r.body.messages.at(-1).payload).toMatchObject({ type: 'report_draft', open_screen: 'C2' });
  });
});

describe('dashboards (brief §5)', () => {
  it('citizen dashboard', async () => {
    const r = await api().get('/api/v1/dashboard/citizen').set(auth(state.c1.token)).expect(200);
    expect(r.body.recent_reports).toHaveLength(1);
    expect(r.body.feedback_history).toHaveLength(2);
  });
  it('officer dashboard with department workload', async () => {
    const r = await api().get('/api/v1/dashboard/officer').set(auth(state.officer.token)).expect(200);
    expect(r.body.resolution_stats.resolved_this_month).toBeGreaterThanOrEqual(1);
    expect(r.body.department_workload[0].officer).toBe('J. Officer');
  });
  it('admin dashboard: trends, categories, hotspots, usage', async () => {
    await api().get('/api/v1/dashboard/admin').set(auth(state.officer.token)).expect(403);
    const r = await api().get('/api/v1/dashboard/admin').set(auth(state.admin.token)).expect(200);
    expect(r.body.kpis.reports_received).toBeGreaterThanOrEqual(2); // merged duplicates are not double-counted
    expect(r.body.popular_categories[0].category).toBeTruthy();
    expect(r.body.system_usage.sign_ins).toBeGreaterThan(0);
    expect(r.body.volume_trend.length).toBeGreaterThan(25);
  });
});

describe('administration (FR-03, FR-16, FR-23, FR-24, FR-30)', () => {
  it('changes a user\'s role (profile moves to the new specialization)', async () => {
    const r = await api().patch(`/api/v1/admin/users/${state.c2.id}`).set(auth(state.admin.token))
      .send({ role: 'officer', employee_no: 'EMP-2002', department_id: state.roads.id }).expect(200);
    expect(r.body).toMatchObject({ role: 'officer', employee_no: 'EMP-2002' });
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM citizen_profiles WHERE user_id = $1', [state.c2.id]);
    expect(rows[0].n).toBe(0);
  });

  it('edits a category SLA and keywords, with an audit entry', async () => {
    const cats = await api().get('/api/v1/admin/categories').set(auth(state.admin.token)).expect(200);
    const graffiti = cats.body.find((c: any) => c.slug === 'safety-graffiti');
    await api().patch(`/api/v1/admin/categories/${graffiti.id}`).set(auth(state.admin.token)).send({ sla_days: 7, keywords: ['graffiti', 'tagging', 'spray paint'] }).expect(200);
    const log = await api().get('/api/v1/admin/audit-logs').query({ action: 'sla_edited' }).set(auth(state.admin.token)).expect(200);
    expect(log.body.data[0].entity_id).toBe(String(graffiti.id));
  });

  it('switches AI categorisation off (manual fallback stays available)', async () => {
    await api().put('/api/v1/admin/ai-settings/categorize').set(auth(state.admin.token)).send({ is_enabled: false }).expect(200);
    const r = await api().post('/api/v1/admin/ai-settings/test').set(auth(state.admin.token)).send({ text: 'Streetlight not working on Park Ave' }).expect(200);
    expect(r.body.source).toBe('fallback');
  });

  it('records sign-ins and status changes in the audit log', async () => {
    const r = await api().get('/api/v1/admin/audit-logs').query({ page_size: 100 }).set(auth(state.admin.token)).expect(200);
    const actions = new Set(r.body.data.map((l: any) => l.action));
    for (const a of ['signed_in', 'status_changed', 'assignment_changed', 'ai_overridden', 'role_changed']) expect(actions).toContain(a);
  });

  it('builds a CSV export for an officer, but not an admin-only report', async () => {
    await api().post('/api/v1/exports').set(auth(state.officer.token)).send({ report_type: 'audit_log', format: 'csv' }).expect(403);
    const job = await api().post('/api/v1/exports').set(auth(state.officer.token)).send({ report_type: 'incident_list', format: 'csv' }).expect(202);
    await jobs.runExportJobs();
    const r = await api().get(`/api/v1/exports/${job.body.id}`).set(auth(state.officer.token)).expect(200);
    expect(r.body).toMatchObject({ status: 'done', row_count: 3 });
    const csv = await api().get(new URL(r.body.download_url).pathname).expect(200);
    expect(csv.text.split('\n')[0]).toContain('incident_no,title,category');
    expect(csv.text).toContain(state.inc.reference_no);
  });

  it('builds a PDF performance report for the admin', async () => {
    const job = await api().post('/api/v1/exports').set(auth(state.admin.token)).send({ report_type: 'sla_performance', format: 'pdf' }).expect(202);
    await jobs.runExportJobs();
    const r = await api().get(`/api/v1/exports/${job.body.id}`).set(auth(state.admin.token)).expect(200);
    expect(r.body.status).toBe('done');
  });
});

describe('background jobs', () => {
  it('delivers queued emails', async () => {
    const before = sentMail.length;
    const sent = await jobs.deliverNotifications(500);
    expect(sent).toBeGreaterThan(0);
    expect(sentMail.length).toBe(before + sent);
  });

  it('summarises long reports automatically', async () => {
    const long =
      'Water is gushing from a burst pipe under the footpath outside the primary school gate on Hill Road. ' +
      'It started around 7am and the water is now running down the gutter and pooling at the pedestrian crossing. ' +
      'Parents are walking children through it on the way in and the pavement is getting slippery. ' +
      'The water pressure in the houses on the street also seems lower than usual since this morning. ' +
      'There is a small sinking patch in the grass verge next to the leak which looks like it is getting bigger.';
    const c3 = await signUpCitizen('long@mail.example', 'Long Writer');
    const r = await api().post('/api/v1/incidents').set(auth(c3.token)).send({ title: 'Water leak at school', description: long, lat: -33.875, lng: 151.2 }).expect(201);
    expect(r.body.top_category).toBe('Utilities and Infrastructure');
    await jobs.generateSummaries();
    const d = await api().get(`/api/v1/incidents/${r.body.id}`).set(auth(state.officer.token)).expect(200);
    expect(d.body.ai_summary.length).toBeLessThan(long.length);
  });

  it('writes the monthly summary and refreshes stats', async () => {
    const body = await jobs.previousMonthSummary(new Date(Date.now() + 40 * 864e5));
    expect(body).toMatch(/reports received/);
    await jobs.refreshStats();
  });
});

describe('privacy', () => {
  it('erases a citizen account but keeps the incident history anonymous', async () => {
    const c = await signUpCitizen('bye@mail.example', 'Bye Now');
    await api().delete('/api/v1/me').set(auth(c.token)).expect(204);
    const { rows } = await pool.query('SELECT full_name, status, deleted_at FROM users WHERE id = $1', [c.id]);
    expect(rows[0]).toMatchObject({ full_name: 'Deleted user', status: 'inactive' });
    await api().post('/api/v1/auth/login').send({ email: 'bye@mail.example', password: 'Secret123' }).expect(401);
  });
});
