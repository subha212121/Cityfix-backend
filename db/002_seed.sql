-- =============================================================================
--  CityFix – reference data and defaults (v2)
--  Categories follow the client brief: Road Maintenance, Waste Management,
--  Traffic Management, Public Safety, Environmental Issues,
--  Utilities and Infrastructure.
-- =============================================================================
BEGIN;

-- Departments ------------------------------------------------------------------
INSERT INTO departments (name, code, email) VALUES
  ('Roads maintenance',            'ROADS',   'roads@council.example'),
  ('Waste services',               'WASTE',   'waste@council.example'),
  ('Traffic and transport',        'TRAFFIC', 'traffic@council.example'),
  ('Community safety',             'SAFETY',  'safety@council.example'),
  ('Environment and parks',        'ENVIRO',  'environment@council.example'),
  ('Utilities and infrastructure', 'UTIL',    'utilities@council.example'),
  ('Information technology',       'IT',      'it@council.example');

-- Teams and crews ----------------------------------------------------------------
INSERT INTO teams (department_id, name, is_field_crew)
SELECT d.id, t.name, t.crew
FROM (VALUES
  ('ROADS',   'Roads office',            false),
  ('ROADS',   'Roads crew A',            true),
  ('ROADS',   'Roads crew B',            true),
  ('WASTE',   'Waste team',              true),
  ('WASTE',   'Illegal dumping team',    true),
  ('TRAFFIC', 'Traffic signals team',    true),
  ('TRAFFIC', 'Parking and traffic officers', true),
  ('SAFETY',  'Graffiti crew',           true),
  ('SAFETY',  'Community safety team',   false),
  ('ENVIRO',  'Parks crew',              true),
  ('ENVIRO',  'Environmental health team', false),
  ('UTIL',    'Lighting team',           true),
  ('UTIL',    'Water and drainage crew', true)
) AS t(dept, name, crew)
JOIN departments d ON d.code = t.dept;

-- Wards (sample boundaries; replace with the council's real GeoJSON) ------------------
INSERT INTO wards (name, code, boundary) VALUES
  ('North ward', 'N', ST_GeomFromText('MULTIPOLYGON(((151.18 -33.87,151.24 -33.87,151.24 -33.84,151.18 -33.84,151.18 -33.87)))', 4326)),
  ('South ward', 'S', ST_GeomFromText('MULTIPOLYGON(((151.18 -33.90,151.24 -33.90,151.24 -33.87,151.18 -33.87,151.18 -33.90)))', 4326)),
  ('East ward',  'E', ST_GeomFromText('MULTIPOLYGON(((151.24 -33.90,151.28 -33.90,151.28 -33.84,151.24 -33.84,151.24 -33.90)))', 4326)),
  ('West ward',  'W', ST_GeomFromText('MULTIPOLYGON(((151.14 -33.90,151.18 -33.90,151.18 -33.84,151.14 -33.84,151.14 -33.90)))', 4326));

-- The six brief categories -------------------------------------------------------
INSERT INTO categories (name, slug, default_department_id, default_team_id, sla_days, sort_order, description)
SELECT c.name, c.slug, d.id, t.id, c.sla, c.ord, c.descr
FROM (VALUES
  ('Road Maintenance',             'road-maintenance', 'ROADS',   'Roads office',          5, 1, 'Potholes, damaged roads and footpaths'),
  ('Waste Management',             'waste-management', 'WASTE',   'Waste team',            3, 2, 'Illegal dumping, bins and collections'),
  ('Traffic Management',           'traffic-management','TRAFFIC','Traffic signals team',  2, 3, 'Signals, signs, congestion and parking'),
  ('Public Safety',                'public-safety',    'SAFETY',  'Community safety team', 2, 4, 'Graffiti, vandalism and unsafe places'),
  ('Environmental Issues',         'environmental',    'ENVIRO',  'Environmental health team', 5, 5, 'Trees, pollution, noise and parks'),
  ('Utilities and Infrastructure', 'utilities',        'UTIL',    'Lighting team',         3, 6, 'Streetlights, water, drainage and public assets')
) AS c(name, slug, dept, team, sla, ord, descr)
JOIN departments d ON d.code = c.dept
JOIN teams t ON t.department_id = d.id AND t.name = c.team;

-- Subcategories, each routed to the team that fixes it ------------------------------
INSERT INTO categories (parent_id, name, slug, default_department_id, default_team_id, sla_days, sort_order)
SELECT p.id, c.name, c.slug, p.default_department_id, t.id, coalesce(c.sla, p.sla_days), c.ord
FROM (VALUES
  ('road-maintenance', 'Pothole',                       'road-pothole',          'Roads crew B',          NULL, 1),
  ('road-maintenance', 'Road surface damage',           'road-surface',          'Roads crew A',          NULL, 2),
  ('road-maintenance', 'Damaged footpath',              'road-footpath',         'Roads crew A',          NULL, 3),
  ('waste-management', 'Illegal dumping',               'waste-dumping',         'Illegal dumping team',  NULL, 1),
  ('waste-management', 'Overflowing public bin',        'waste-bin',             'Waste team',            2,    2),
  ('waste-management', 'Missed collection',             'waste-missed',          'Waste team',            NULL, 3),
  ('traffic-management','Faulty traffic signal',        'traffic-signal',        'Traffic signals team',  1,    1),
  ('traffic-management','Damaged or missing sign',      'traffic-sign',          'Traffic signals team',  NULL, 2),
  ('traffic-management','Congestion or road hazard',    'traffic-congestion',    'Parking and traffic officers', NULL, 3),
  ('traffic-management','Illegal parking',              'traffic-parking',       'Parking and traffic officers', NULL, 4),
  ('public-safety',    'Graffiti',                      'safety-graffiti',       'Graffiti crew',         5,    1),
  ('public-safety',    'Vandalism',                     'safety-vandalism',      'Graffiti crew',         NULL, 2),
  ('public-safety',    'Unsafe area or hazard',         'safety-hazard',         'Community safety team', 1,    3),
  ('public-safety',    'Abandoned vehicle',             'safety-vehicle',        'Community safety team', 5,    4),
  ('environmental',    'Fallen tree or branch',         'enviro-tree',           'Parks crew',            2,    1),
  ('environmental',    'Pollution or spill',            'enviro-pollution',      'Environmental health team', 1, 2),
  ('environmental',    'Noise complaint',               'enviro-noise',          'Environmental health team', NULL, 3),
  ('environmental',    'Park or playground damage',     'enviro-park',           'Parks crew',            NULL, 4),
  ('utilities',        'Streetlight failure',           'util-streetlight',      'Lighting team',         NULL, 1),
  ('utilities',        'Water leak',                    'util-water-leak',       'Water and drainage crew', 1,  2),
  ('utilities',        'Blocked drain or flooding',     'util-drain',            'Water and drainage crew', 2,  3),
  ('utilities',        'Damaged public asset',          'util-asset',            'Lighting team',         NULL, 4)
) AS c(parent_slug, name, slug, team, sla, ord)
JOIN categories p ON p.slug = c.parent_slug
JOIN teams t ON t.department_id = p.default_department_id AND t.name = c.team;

-- Keywords that help the AI and the fallback classifier -------------------------------
INSERT INTO category_keywords (category_id, keyword)
SELECT c.id, k.kw
FROM (VALUES
  ('road-maintenance', 'road'), ('road-maintenance', 'street'), ('road-maintenance', 'kerb'),
  ('road-pothole', 'pothole'), ('road-pothole', 'hole'), ('road-pothole', 'crack'),
  ('road-surface', 'bitumen'), ('road-surface', 'subsidence'), ('road-surface', 'uneven road'),
  ('road-footpath', 'footpath'), ('road-footpath', 'sidewalk'), ('road-footpath', 'trip hazard'),
  ('waste-dumping', 'dumped'), ('waste-dumping', 'dumping'), ('waste-dumping', 'mattress'), ('waste-dumping', 'rubbish pile'),
  ('waste-bin', 'bin'), ('waste-bin', 'overflowing'), ('waste-bin', 'litter'),
  ('waste-missed', 'missed collection'), ('waste-missed', 'not collected'), ('waste-missed', 'garbage truck'),
  ('traffic-signal', 'traffic light'), ('traffic-signal', 'signal'), ('traffic-signal', 'lights not working'),
  ('traffic-sign', 'stop sign'), ('traffic-sign', 'give way'), ('traffic-sign', 'sign'),
  ('traffic-congestion', 'congestion'), ('traffic-congestion', 'traffic jam'), ('traffic-congestion', 'blocked road'),
  ('traffic-parking', 'parked'), ('traffic-parking', 'parking'), ('traffic-parking', 'driveway'),
  ('safety-graffiti', 'graffiti'), ('safety-graffiti', 'tag'), ('safety-graffiti', 'spray paint'),
  ('safety-vandalism', 'vandal'), ('safety-vandalism', 'smashed'), ('safety-vandalism', 'broken glass'),
  ('safety-hazard', 'unsafe'), ('safety-hazard', 'dangerous'), ('safety-hazard', 'exposed wires'), ('safety-hazard', 'needle'),
  ('safety-vehicle', 'abandoned car'), ('safety-vehicle', 'abandoned vehicle'),
  ('enviro-tree', 'tree'), ('enviro-tree', 'branch'), ('enviro-tree', 'fallen'),
  ('enviro-pollution', 'oil'), ('enviro-pollution', 'spill'), ('enviro-pollution', 'smell'), ('enviro-pollution', 'pollution'),
  ('enviro-noise', 'noise'), ('enviro-noise', 'loud'), ('enviro-noise', 'music'),
  ('enviro-park', 'park'), ('enviro-park', 'playground'), ('enviro-park', 'bench'),
  ('util-streetlight', 'streetlight'), ('util-streetlight', 'street light'), ('util-streetlight', 'lamp'), ('util-streetlight', 'dark'),
  ('util-water-leak', 'leak'), ('util-water-leak', 'burst'), ('util-water-leak', 'water main'), ('util-water-leak', 'hydrant'),
  ('util-drain', 'drain'), ('util-drain', 'flood'), ('util-drain', 'gutter'), ('util-drain', 'stormwater'),
  ('util-asset', 'pit lid'), ('util-asset', 'power pole'), ('util-asset', 'bollard')
) AS k(slug, kw)
JOIN categories c ON c.slug = k.slug;

-- Critical priority = 24-hour SLA on every category.
INSERT INTO sla_priority_overrides (category_id, priority, sla_hours)
SELECT id, 'critical', 24 FROM categories;

-- Status workflow ------------------------------------------------------------------
INSERT INTO incident_status_transitions (from_status, to_status, allowed_roles, description) VALUES
  ('new',          'under_review', '{officer,admin}',         'Officer starts reviewing'),
  ('new',          'rejected',     '{officer,admin}',         'Invalid, spam or not council'),
  ('new',          'closed',       '{officer,admin}',         'Merged as duplicate'),
  ('under_review', 'assigned',     '{officer,admin}',         'Assigned to a department team or crew'),
  ('under_review', 'rejected',     '{officer,admin}',         'Invalid, spam or not council'),
  ('under_review', 'closed',       '{officer,admin}',         'Merged as duplicate'),
  ('assigned',     'in_progress',  '{officer,admin}',         'Crew started work'),
  ('assigned',     'under_review', '{officer,admin}',         'Unassigned for re-triage'),
  ('assigned',     'closed',       '{officer,admin}',         'Merged as duplicate'),
  ('in_progress',  'resolved',     '{officer,admin}',         'Fixed, note added'),
  ('in_progress',  'assigned',     '{officer,admin}',         'Paused or handed to another crew'),
  ('resolved',     'closed',       '{citizen,officer,admin}', 'Citizen confirms, staff closes, or auto-close'),
  ('resolved',     'in_progress',  '{citizen,officer,admin}', 'Reopened: not fully fixed'),
  ('rejected',     'under_review', '{admin}',                 'Admin reconsiders a rejected report');

-- Feedback chips (C11) -------------------------------------------------------------
INSERT INTO feedback_tags (code, label, is_positive, sort_order) VALUES
  ('fixed_quickly',   'Fixed quickly',   true,  1),
  ('good_quality',    'Good quality',    true,  2),
  ('kept_me_updated', 'Kept me updated', true,  3),
  ('not_fully_fixed', 'Not fully fixed', false, 4);

-- AI feature switches -----------------------------------------------------------------
INSERT INTO ai_settings (feature, is_enabled, auto_apply_threshold, config) VALUES
  ('categorize',       true, 0.850, '{"show_to_citizen": true}'),
  ('prioritize',       true, NULL,  '{"must_give_reason": true}'),
  ('incident_summary', true, NULL,  '{"min_description_chars": 400, "summarise_merged_reports": true}'),
  ('chatbot',          true, NULL,  '{"welcome_message": "Hi! I can explain how reporting works, help you lodge a report, or check the status of one.",
                                      "sources": ["faq", "report_status", "council_services"],
                                      "handover_when": "citizen_asks_or_ai_unsure"}'),
  ('monthly_summary',  true, NULL,  '{}');

-- System settings ---------------------------------------------------------------------
INSERT INTO system_settings (key, value, description) VALUES
  ('auto_close_days',        '7',       'Resolved incidents close after this many days without a citizen response'),
  ('duplicate_radius_m',     '50',      'Distance used to suggest possible duplicates'),
  ('nearby_radius_m',        '1000',    '"Near you" radius on the citizen home screen'),
  ('max_photos_per_report',  '3',       'Photos per report'),
  ('max_photo_bytes',        '5242880', '5 MB per photo'),
  ('ai_timeout_ms',          '8000',    'After this the form falls back to manual category'),
  ('password_min_length',    '8',       'Sign-up and password change'),
  ('data_retention_years',   '7',       'Keep closed incidents this long, then anonymise');

-- FAQ (Help screen + chatbot knowledge) ------------------------------------------------
INSERT INTO faq_articles (question, answer, sort_order) VALUES
  ('How do I report an issue?', 'Tap "Report an issue", add a short title, describe the problem, set the location on the map and add up to 3 photos. The app suggests a category and you can change it before you submit.', 1),
  ('How long will my report take?', 'Each category has a target time, from 1 day for urgent hazards to 5 days for routine repairs. You can follow progress under My reports.', 2),
  ('What do the statuses mean?', 'New: received. Under Review: an officer is checking it. Assigned: a team has it. In Progress: work has started. Resolved: the council says it is fixed. Closed: finished.', 3),
  ('Can I report anonymously?', 'Yes. Your name is hidden on the public map and from staff handling the job. We still use your account to send you updates.', 4),
  ('What if the problem is not fixed?', 'When a report is Resolved you can rate the fix. Choose "Not fully fixed" to reopen it.', 5),
  ('Who sees my photos?', 'Photos are checked before they appear publicly. Location data is removed from the image file.', 6);

-- First admin (CHANGE THE PASSWORD). Profile in the same transaction: the
-- specialization check runs at COMMIT.
WITH u AS (
  INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at)
  VALUES ('admin@council.example', crypt('ChangeMe!2026', gen_salt('bf', 12)), 'A. Admin', 'admin', 'active', now())
  RETURNING id
)
INSERT INTO admin_profiles (user_id, employee_no, department_id, access_level)
SELECT u.id, 'EMP-0001', d.id, 'super' FROM u, departments d WHERE d.code = 'IT';

COMMIT;
