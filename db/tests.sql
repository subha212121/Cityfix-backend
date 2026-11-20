-- =============================================================================
--  CityFix – smoke tests. Run on a throw-away database after schema + seed:
--    psql -v ON_ERROR_STOP=1 -d cityfix_test -f tests.sql
--  Every check raises an exception if it fails; the script ends with ROLLBACK.
-- =============================================================================
BEGIN;

-- Helper: expect a statement to fail
CREATE FUNCTION pg_temp.expect_error(p_sql text, p_label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    EXECUTE p_sql;
    RAISE EXCEPTION 'FAIL (should have errored): %', p_label;
EXCEPTION WHEN others THEN
    IF SQLERRM LIKE 'FAIL%' THEN RAISE; END IF;
    RAISE NOTICE 'ok  – blocked: % (%)', p_label, SQLERRM;
END $$;

CREATE FUNCTION pg_temp.check(p_ok boolean, p_label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT coalesce(p_ok, false) THEN RAISE EXCEPTION 'FAIL: %', p_label; END IF;
    RAISE NOTICE 'ok  – %', p_label;
END $$;

-- Reference data matches the brief ---------------------------------------------------
SELECT pg_temp.check((SELECT array_agg(name ORDER BY sort_order) FROM categories WHERE parent_id IS NULL)
    = ARRAY['Road Maintenance','Waste Management','Traffic Management','Public Safety','Environmental Issues','Utilities and Infrastructure'],
    'six top-level categories from the brief');

-- Test users (each with the profile for its role) -----------------------------------------
INSERT INTO users (id, email, password_hash, full_name, role, status) VALUES
  ('00000000-0000-0000-0000-0000000000c1', 'r.resident@mail.example', 'x', 'R. Resident', 'citizen', 'active'),
  ('00000000-0000-0000-0000-0000000000c2', 't.resident@mail.example', 'x', 'T. Resident', 'citizen', 'active'),
  ('00000000-0000-0000-0000-0000000000a1', 'j.officer@council.example', 'x', 'J. Officer', 'officer', 'active');
INSERT INTO citizen_profiles (user_id) VALUES ('00000000-0000-0000-0000-0000000000c1'), ('00000000-0000-0000-0000-0000000000c2');
INSERT INTO officer_profiles (user_id, employee_no, department_id, team_id)
SELECT '00000000-0000-0000-0000-0000000000a1', 'EMP-1001', d.id, t.id
FROM departments d JOIN teams t ON t.department_id = d.id AND t.name = 'Roads crew B' WHERE d.code = 'ROADS';

-- Specialization rules (EERD) ---------------------------------------------------------------
SELECT pg_temp.expect_error($$INSERT INTO citizen_profiles (user_id) VALUES ('00000000-0000-0000-0000-0000000000a1')$$,
                            'citizen profile for an officer (disjoint)');
SAVEPOINT team_check;
INSERT INTO users (id, email, full_name, role, status)
VALUES ('00000000-0000-0000-0000-0000000000a9', 'x.officer@council.example', 'X. Officer', 'officer', 'pending');
SELECT pg_temp.expect_error($$INSERT INTO officer_profiles (user_id, employee_no, department_id, team_id)
    SELECT '00000000-0000-0000-0000-0000000000a9', 'EMP-9', d.id, t.id FROM departments d, teams t
    WHERE d.code = 'WASTE' AND t.name = 'Roads crew B'$$, 'officer team outside their department');
ROLLBACK TO SAVEPOINT team_check;
SAVEPOINT total_check;
INSERT INTO users (email, full_name, role, status) VALUES ('nobody@mail.example', 'No Profile', 'citizen', 'pending');
SELECT pg_temp.expect_error($$SET CONSTRAINTS ALL IMMEDIATE$$, 'user without a profile (total)');
ROLLBACK TO SAVEPOINT total_check;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT pg_temp.check(true, 'all test users have their profile');
SET CONSTRAINTS ALL DEFERRED;

-- Work as the API role from here on
SET ROLE cityfix_app;

-- 1. Citizen submits a report (C2) ------------------------------------------------
SET app.user_id = '00000000-0000-0000-0000-0000000000c1';
SET app.role = 'citizen';

INSERT INTO incidents (title, description, reporter_id, location, address, category_id,
                       ai_category_id, ai_priority, ai_priority_reason, ai_confidence, priority, priority_source, category_source)
SELECT 'Pothole on Smith St', 'Big pothole in the left lane, cars are swerving around it.',
       '00000000-0000-0000-0000-0000000000c1',
       ST_MakePoint(151.2093, -33.8600)::geography, '14 Smith St',
       c.id, c.id, 'high', 'Busy road, vehicles swerving: safety risk', 0.92, 'high', 'ai', 'ai'
FROM categories c WHERE c.slug = 'road-pothole';

SELECT pg_temp.check((SELECT reference_no ~ '^INC-\d{4}-\d{5}$' FROM incidents WHERE title = 'Pothole on Smith St'),
                     'incident number format INC-YYYY-NNNNN');
SELECT pg_temp.check((SELECT w.name = 'North ward' FROM incidents i JOIN wards w ON w.id = i.ward_id WHERE i.title = 'Pothole on Smith St'),
                     'ward set from location (PostGIS)');
SELECT pg_temp.check((SELECT d.code = 'ROADS' FROM incidents i JOIN departments d ON d.id = i.assigned_department_id WHERE i.title = 'Pothole on Smith St'),
                     'routed to category department');
SELECT pg_temp.check((SELECT sla_due_at BETWEEN created_at + interval '4 days 23 hours' AND created_at + interval '5 days 1 hour'
                      FROM incidents WHERE title = 'Pothole on Smith St'), 'SLA = 5 days for Road Maintenance');
SELECT pg_temp.check((SELECT count(*) = 1 FROM incident_status_history h JOIN incidents i ON i.id = h.incident_id
                      WHERE i.title = 'Pothole on Smith St' AND h.to_status = 'new'), 'status history row on create');

-- Photos: 3 allowed, 4th blocked, >5 MB blocked, wrong type blocked
INSERT INTO incident_attachments (incident_id, uploaded_by, storage_key, mime_type, size_bytes)
SELECT i.id, '00000000-0000-0000-0000-0000000000c1', 'photos/' || g, 'image/jpeg', 1000000
FROM incidents i, generate_series(1, 3) g WHERE i.title = 'Pothole on Smith St';
SELECT pg_temp.expect_error($$INSERT INTO incident_attachments (incident_id, uploaded_by, storage_key, mime_type, size_bytes)
    SELECT id, '00000000-0000-0000-0000-0000000000c1', 'photos/4', 'image/jpeg', 1000 FROM incidents WHERE title = 'Pothole on Smith St'$$,
    '4th photo');

-- Citizen cannot triage or edit
SELECT pg_temp.expect_error($$UPDATE incidents SET status = 'under_review' WHERE title = 'Pothole on Smith St'$$,
                            'citizen moving new → under_review');
SELECT pg_temp.expect_error($$UPDATE incidents SET priority = 'low' WHERE title = 'Pothole on Smith St'$$,
                            'citizen editing priority');

-- A second citizen reports the same thing nearby (duplicate) and supports it
SET app.user_id = '00000000-0000-0000-0000-0000000000c2';
INSERT INTO incidents (title, description, reporter_id, location, category_id, is_anonymous)
SELECT 'Pothole Smith Street', 'Huge hole in the road near number 16.',
       '00000000-0000-0000-0000-0000000000c2', ST_MakePoint(151.2094, -33.8601)::geography, c.id, true
FROM categories c WHERE c.slug = 'road-pothole';
-- also a private report from citizen 2 that citizen 1 must not see
INSERT INTO incidents (title, description, reporter_id, location, category_id, is_public)
SELECT 'Private matter', 'Something not for the public map.', '00000000-0000-0000-0000-0000000000c2',
       ST_MakePoint(151.25, -33.88)::geography, c.id, false
FROM categories c WHERE c.slug = 'waste-missed';

SET app.user_id = '00000000-0000-0000-0000-0000000000c1';
SELECT pg_temp.check((SELECT count(*) = 0 FROM incidents WHERE title = 'Private matter'),
                     'RLS: citizen cannot see another citizen''s private report');
SELECT pg_temp.check((SELECT count(*) = 2 FROM incidents_nearby(-33.8600, 151.2093, 500)), 'incidents_nearby finds 2 within 500 m');

-- 2. Officer workflow (O1 / O2) ---------------------------------------------------
SET app.user_id = '00000000-0000-0000-0000-0000000000a1';
SET app.role = 'officer';

SELECT pg_temp.check((SELECT count(*) = 1 FROM find_duplicate_candidates((SELECT id FROM incidents WHERE title = 'Pothole Smith Street'))),
                     'duplicate candidate found within 50 m');
SELECT pg_temp.check((SELECT reporter = 'Anonymous citizen' FROM v_officer_queue WHERE title = 'Pothole Smith Street'),
                     'anonymous reporter hidden from officers');

SELECT merge_incident((SELECT id FROM incidents WHERE title = 'Pothole Smith Street'),
                      (SELECT id FROM incidents WHERE title = 'Pothole on Smith St'));
SELECT pg_temp.check((SELECT status = 'closed' AND closure_reason = 'duplicate' FROM incidents WHERE title = 'Pothole Smith Street'),
                     'duplicate merged and closed');
SELECT pg_temp.check((SELECT supporter_count = 1 FROM incidents WHERE title = 'Pothole on Smith St'),
                     'duplicate reporter became a supporter');

SELECT pg_temp.expect_error($$UPDATE incidents SET status = 'resolved' WHERE title = 'Pothole on Smith St'$$,
                            'skipping new → resolved');

UPDATE incidents SET status = 'under_review' WHERE title = 'Pothole on Smith St';
SELECT pg_temp.expect_error($$UPDATE incidents SET status = 'assigned' WHERE title = 'Pothole on Smith St'$$,
                            'assigned without a team/officer');
UPDATE incidents SET status = 'assigned', assigned_team_id = (SELECT id FROM teams WHERE name = 'Roads crew B'),
                     assigned_officer_id = '00000000-0000-0000-0000-0000000000a1'
WHERE title = 'Pothole on Smith St';
SELECT pg_temp.check((SELECT count(*) >= 1 FROM incident_assignments a JOIN incidents i ON i.id = a.incident_id
                      WHERE i.title = 'Pothole on Smith St' AND a.ended_at IS NULL), 'assignment history written');

-- Officer overrides AI priority (FR-28): final value changes, AI value kept
UPDATE incidents SET priority = 'critical', priority_source = 'staff' WHERE title = 'Pothole on Smith St';
SELECT pg_temp.check((SELECT ai_priority = 'high' AND priority = 'critical' FROM incidents WHERE title = 'Pothole on Smith St'),
                     'AI value kept after override');
SELECT pg_temp.check((SELECT sla_due_at < created_at + interval '25 hours' FROM incidents WHERE title = 'Pothole on Smith St'),
                     'critical priority tightens SLA to 24 h');

INSERT INTO incident_messages (incident_id, sender_id, body)
SELECT id, '00000000-0000-0000-0000-0000000000a1', 'Crew booked for Thursday morning.' FROM incidents WHERE title = 'Pothole on Smith St';
INSERT INTO incident_messages (incident_id, sender_id, body, is_internal)
SELECT id, '00000000-0000-0000-0000-0000000000a1', 'Internal: needs traffic control.', true FROM incidents WHERE title = 'Pothole on Smith St';

UPDATE incidents SET status = 'in_progress' WHERE title = 'Pothole on Smith St';
SET app.status_note = 'Pothole filled and sealed.';
UPDATE incidents SET status = 'resolved', resolution_note = 'Pothole filled and sealed.' WHERE title = 'Pothole on Smith St';
SET app.status_note = '';

-- 3. Citizen rates, reopens, then confirms (C5 / C11) -------------------------------
SET app.user_id = '00000000-0000-0000-0000-0000000000c1';
SET app.role = 'citizen';
SELECT pg_temp.check((SELECT count(*) = 1 FROM incident_messages m JOIN incidents i ON i.id = m.incident_id
                      WHERE i.title = 'Pothole on Smith St'), 'citizen sees only the non-internal message');

INSERT INTO incident_ratings (incident_id, citizen_id, score, requested_reopen)
SELECT id, '00000000-0000-0000-0000-0000000000c1', 2, true FROM incidents WHERE title = 'Pothole on Smith St';
INSERT INTO incident_rating_tags (rating_id, tag_code)
SELECT r.id, 'not_fully_fixed' FROM incident_ratings r JOIN incidents i ON i.id = r.incident_id WHERE i.title = 'Pothole on Smith St';
UPDATE incidents SET status = 'in_progress' WHERE title = 'Pothole on Smith St';
SELECT pg_temp.check((SELECT reopen_count = 1 FROM incidents WHERE title = 'Pothole on Smith St'), 'reopen counted');

SET app.user_id = '00000000-0000-0000-0000-0000000000a1';
SET app.role = 'officer';
UPDATE incidents SET status = 'resolved' WHERE title = 'Pothole on Smith St';

SET app.user_id = '00000000-0000-0000-0000-0000000000c1';
SET app.role = 'citizen';
INSERT INTO incident_ratings (incident_id, citizen_id, score)
SELECT id, '00000000-0000-0000-0000-0000000000c1', 5 FROM incidents WHERE title = 'Pothole on Smith St';
UPDATE incidents SET status = 'closed', closure_reason = 'confirmed_by_citizen' WHERE title = 'Pothole on Smith St';
SELECT pg_temp.check((SELECT count(*) = 2 FROM incident_ratings r JOIN incidents i ON i.id = r.incident_id
                      WHERE i.title = 'Pothole on Smith St'), 'one rating per resolution cycle');
SELECT pg_temp.check((SELECT string_agg(to_status::text, '>' ORDER BY h.id) FROM incident_status_history h
                      JOIN incidents i ON i.id = h.incident_id WHERE i.title = 'Pothole on Smith St')
                     = 'new>under_review>assigned>in_progress>resolved>in_progress>resolved>closed',
                     'full status timeline recorded');

SELECT pg_temp.check((SELECT count(*) = 2 FROM v_citizen_feedback_history WHERE citizen_id = '00000000-0000-0000-0000-0000000000c1'),
                     'feedback history view');

-- 4. System jobs (no app.role) ------------------------------------------------------
RESET app.role; RESET app.user_id;
UPDATE incidents SET status = 'under_review' WHERE title = 'Private matter';
UPDATE incidents SET status = 'assigned', assigned_team_id = (SELECT id FROM teams WHERE name = 'Waste team') WHERE title = 'Private matter';
UPDATE incidents SET status = 'in_progress' WHERE title = 'Private matter';
UPDATE incidents SET status = 'resolved' WHERE title = 'Private matter';
UPDATE incidents SET resolved_at = now() - interval '10 days' WHERE title = 'Private matter';
SELECT pg_temp.check(auto_close_resolved_incidents() = 1, 'auto-close after 7 days');

SELECT pg_temp.check((SELECT count(*) > 0 FROM incident_heatmap(now() - interval '1 day', now() + interval '1 day')), 'heatmap returns cells');
SELECT pg_temp.check((SELECT count(*) > 0 FROM audit_logs), 'audit log written');
SELECT pg_temp.expect_error($$DELETE FROM audit_logs$$, 'deleting audit log');

SELECT pg_temp.check((SELECT open_assigned = 0 AND resolved_30d = 1 FROM v_department_workload WHERE officer = 'J. Officer'),
                     'department workload view');
SELECT pg_temp.check((SELECT incidents_reported = 3 FROM v_system_usage_daily WHERE day = now()::date), 'system usage view');

RESET ROLE;
-- Role change keeps the specialization valid
SELECT change_user_role('00000000-0000-0000-0000-0000000000c2', 'officer', 'EMP-2002',
                        (SELECT id FROM departments WHERE code = 'WASTE'));
SET CONSTRAINTS ALL IMMEDIATE;
SELECT pg_temp.check((SELECT role = 'officer' FROM v_users WHERE email = 't.resident@mail.example')
                     AND NOT EXISTS (SELECT 1 FROM citizen_profiles WHERE user_id = '00000000-0000-0000-0000-0000000000c2'),
                     'change_user_role moves the profile');
SET CONSTRAINTS ALL DEFERRED;
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_incident_stats;
SELECT pg_temp.check((SELECT sum(received) = 3 FROM mv_daily_incident_stats), 'daily stats materialized view');

DO $$ BEGIN RAISE NOTICE 'ALL TESTS PASSED'; END $$;
ROLLBACK;
