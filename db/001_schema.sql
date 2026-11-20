-- =============================================================================
--  CityFix – Smart City Incident Reporting & Analytics Platform
--  PostgreSQL 14+ / PostGIS 3+ database schema  —  version 2
--
--  v2 changes: brief's six incident categories (seed), the three user roles
--  as a disjoint + total specialization (users → citizen_profiles /
--  officer_profiles / admin_profiles), array columns replaced by junction
--  tables (category_keywords, incident_rating_tags), usage/workload/feedback
--  views for the dashboards, chatbot report drafts.
--
--  Covers FR-01 … FR-30 from the Figma requirements-coverage table, plus the
--  gaps found in the wireframe review (reopen, rejected reports, duplicates,
--  crews, chatbot hand-over, invitations, wards, FAQ, exports, auto-close).
--
--  Run order:  schema.sql  →  seed.sql
--  Run as a superuser (or the DB owner with rights to CREATE EXTENSION).
--
--  Design decisions (change them here if the team decides otherwise)
--  -----------------------------------------------------------------
--  D1  Status flow:  new → under_review → assigned → in_progress → resolved → closed
--      plus  rejected  (invalid / not council / spam)  and reopen
--      (resolved → in_progress, counted in incidents.reopen_count).
--      Allowed moves live in table incident_status_transitions.
--  D2  Duplicates: every citizen submission is its own incident. Merging sets
--      merged_into_id on the duplicate and closes it with closure_reason
--      'duplicate'. "I see this too" adds a row in incident_supporters.
--  D3  Anonymous: citizens must sign in (FR-01). "Report anonymously" hides
--      their identity from the public map and from officers' screens, but the
--      reporter_id is kept so they still get notifications.
--  D4  Crews have no logins. They are rows in `teams`; officers update the
--      incident on the crew's behalf and can upload before/after photos.
--  D5  Priorities: low, medium, high, critical (A5 used "Critical").
--  D6  Incident numbers: INC-YYYY-NNNNN, restarting each year (C9, A5, A7).
--  D7  AI never overwrites human choices silently: every AI output is kept in
--      ai_predictions, and the accepted/overridden value is recorded (FR-28).
--  D8  Coordinates are WGS 84 (SRID 4326). Points are stored as geography so
--      distances are in metres; ward boundaries are geometry for fast
--      point-in-polygon.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Extensions
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS postgis;       -- spatial types and functions
CREATE EXTENSION IF NOT EXISTS citext;        -- case-insensitive email
CREATE EXTENSION IF NOT EXISTS pgcrypto;      -- gen_random_uuid(), digest()
CREATE EXTENSION IF NOT EXISTS pg_trgm;       -- fuzzy search on title/address

-- -----------------------------------------------------------------------------
-- 1. Enumerated types
-- -----------------------------------------------------------------------------
CREATE TYPE user_role          AS ENUM ('citizen', 'officer', 'admin');
CREATE TYPE account_status     AS ENUM ('pending', 'active', 'inactive');
CREATE TYPE incident_status    AS ENUM ('new', 'under_review', 'assigned',
                                        'in_progress', 'resolved', 'closed',
                                        'rejected');
CREATE TYPE priority_level     AS ENUM ('low', 'medium', 'high', 'critical');
CREATE TYPE closure_reason     AS ENUM ('confirmed_by_citizen', 'auto_closed',
                                        'closed_by_staff', 'duplicate',
                                        'invalid', 'not_council_responsibility',
                                        'spam');
CREATE TYPE attachment_kind    AS ENUM ('citizen_photo', 'before_photo',
                                        'after_photo', 'message_attachment');
CREATE TYPE moderation_status  AS ENUM ('pending', 'approved', 'hidden');
CREATE TYPE auth_token_purpose AS ENUM ('email_verification', 'password_reset');
CREATE TYPE notification_channel AS ENUM ('in_app', 'email', 'push');
CREATE TYPE delivery_status    AS ENUM ('queued', 'sent', 'failed', 'skipped');
CREATE TYPE notification_event AS ENUM (
    'report_received',        -- citizen: C9
    'status_changed',         -- citizen: C6
    'message_received',       -- citizen + officer: C10 / O5
    'rating_requested',       -- citizen: after resolved
    'incident_assigned',      -- officer: O5 "new incident assigned to me"
    'incident_reassigned',    -- officer: O5
    'incident_reopened',      -- officer: O6 preference
    'sla_due_soon',           -- officer: SLA due within 24 h
    'sla_breached',           -- officer + admin
    'rating_received',        -- officer: O5
    'chat_handover',          -- officer: citizen asked for a person
    'daily_queue_summary',    -- officer: O6 preference
    'export_ready'            -- admin: A8
);
CREATE TYPE ai_feature         AS ENUM ('categorize', 'prioritize',
                                        'incident_summary', 'chatbot',
                                        'monthly_summary');
CREATE TYPE ai_run_status      AS ENUM ('success', 'failed', 'timeout',
                                        'disabled');
CREATE TYPE ai_decision        AS ENUM ('pending', 'accepted', 'overridden',
                                        'auto_applied', 'ignored');
CREATE TYPE chat_status        AS ENUM ('bot', 'waiting_for_staff',
                                        'with_staff', 'closed');
CREATE TYPE chat_sender        AS ENUM ('citizen', 'bot', 'staff', 'system');
CREATE TYPE export_format      AS ENUM ('csv', 'pdf');
CREATE TYPE export_status      AS ENUM ('queued', 'running', 'done', 'failed');
CREATE TYPE feedback_status    AS ENUM ('new', 'reviewed', 'actioned');
CREATE TYPE admin_access_level AS ENUM ('standard', 'super');

-- -----------------------------------------------------------------------------
-- 2. Shared trigger function: keep updated_at current
-- -----------------------------------------------------------------------------
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$;

-- -----------------------------------------------------------------------------
-- 3. Organisation: departments, teams/crews, wards
-- -----------------------------------------------------------------------------
CREATE TABLE departments (
    id          smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        text        NOT NULL UNIQUE,              -- "Roads maintenance"
    code        text        NOT NULL UNIQUE,              -- "ROADS"
    email       citext,
    is_active   boolean     NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Teams and field crews ("Roads crew B", "Waste team"). D4: no logins.
CREATE TABLE teams (
    id            smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    department_id smallint    NOT NULL REFERENCES departments(id),
    name          text        NOT NULL,
    is_field_crew boolean     NOT NULL DEFAULT false,
    is_active     boolean     NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (department_id, name),
    UNIQUE (id, department_id)              -- lets profiles check team ∈ department
);

-- Council wards, used for filters (O1, O3, A1) and auto-tagging incidents.
CREATE TABLE wards (
    id          smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        text        NOT NULL UNIQUE,              -- "North ward"
    code        text        NOT NULL UNIQUE,
    boundary    geometry(MultiPolygon, 4326) NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT wards_boundary_valid CHECK (ST_IsValid(boundary))
);
CREATE INDEX wards_boundary_gix ON wards USING gist (boundary);

-- -----------------------------------------------------------------------------
-- 4. Users, authentication, preferences  (FR-01 … FR-04)
-- -----------------------------------------------------------------------------
CREATE TABLE users (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    email             citext      NOT NULL UNIQUE,
    password_hash     text,                      -- argon2id/bcrypt, NULL until invite accepted
    full_name         text        NOT NULL,
    phone             text,
    role              user_role   NOT NULL DEFAULT 'citizen',   -- discriminator of the specialization
    status            account_status NOT NULL DEFAULT 'pending',
    avatar_key        text,                      -- object-storage key
    preferred_language text       NOT NULL DEFAULT 'en',
    email_verified_at timestamptz,
    last_active_at    timestamptz,
    failed_login_count smallint   NOT NULL DEFAULT 0,
    locked_until      timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    deleted_at        timestamptz,               -- soft delete / privacy erasure
    CONSTRAINT users_id_role_uq UNIQUE (id, role),   -- target of the profile FKs
    CONSTRAINT users_active_needs_password
        CHECK (status <> 'active' OR password_hash IS NOT NULL)
);
CREATE INDEX users_role_idx       ON users (role) WHERE deleted_at IS NULL;
CREATE INDEX users_name_trgm      ON users USING gin (full_name gin_trgm_ops);

-- -----------------------------------------------------------------------------
-- 4a. Role specialization (EERD): every user is exactly ONE of
--     citizen / officer / admin  (disjoint, total).
--     * Disjoint: each profile's FK is (user_id, role) → users(id, role) and the
--       profile's role column is pinned by a CHECK, so a citizen row can only
--       point at a user whose role is 'citizen'.
--     * Total: a deferred constraint trigger checks at COMMIT that every user
--       has the profile matching its role.
--     * Changing role: use change_user_role() (section 11).
-- -----------------------------------------------------------------------------
CREATE TABLE citizen_profiles (
    user_id            uuid        PRIMARY KEY,
    role               user_role   NOT NULL DEFAULT 'citizen' CHECK (role = 'citizen'),
    home_suburb        text,
    home_location      geography(Point, 4326),        -- centre for "Near you"
    default_anonymous  boolean     NOT NULL DEFAULT false,
    accepted_terms_at  timestamptz NOT NULL DEFAULT now(),
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (user_id, role) REFERENCES users (id, role) ON DELETE CASCADE
);

CREATE TABLE officer_profiles (
    user_id              uuid        PRIMARY KEY,
    role                 user_role   NOT NULL DEFAULT 'officer' CHECK (role = 'officer'),
    employee_no          text        NOT NULL UNIQUE,
    position_title       text,
    department_id        smallint    NOT NULL REFERENCES departments(id),
    team_id              smallint,
    is_supervisor        boolean     NOT NULL DEFAULT false,
    max_open_assignments smallint    NOT NULL DEFAULT 25 CHECK (max_open_assignments > 0),
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (user_id, role) REFERENCES users (id, role) ON DELETE CASCADE,
    FOREIGN KEY (team_id, department_id) REFERENCES teams (id, department_id)
);
CREATE INDEX officer_profiles_department_idx ON officer_profiles (department_id);

CREATE TABLE admin_profiles (
    user_id        uuid               PRIMARY KEY,
    role           user_role          NOT NULL DEFAULT 'admin' CHECK (role = 'admin'),
    employee_no    text               NOT NULL UNIQUE,
    department_id  smallint           REFERENCES departments(id),
    access_level   admin_access_level NOT NULL DEFAULT 'standard',
    created_at     timestamptz        NOT NULL DEFAULT now(),
    updated_at     timestamptz        NOT NULL DEFAULT now(),
    FOREIGN KEY (user_id, role) REFERENCES users (id, role) ON DELETE CASCADE
);

CREATE FUNCTION assert_user_has_profile(p_user uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_role user_role;
    v_ok   boolean;
BEGIN
    SELECT role INTO v_role FROM users WHERE id = p_user;
    IF NOT FOUND THEN RETURN; END IF;            -- user deleted: nothing to check
    v_ok := CASE v_role
        WHEN 'citizen' THEN EXISTS (SELECT 1 FROM citizen_profiles WHERE user_id = p_user)
        WHEN 'officer' THEN EXISTS (SELECT 1 FROM officer_profiles WHERE user_id = p_user)
        WHEN 'admin'   THEN EXISTS (SELECT 1 FROM admin_profiles   WHERE user_id = p_user)
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'User % has role % but no % profile', p_user, v_role, v_role
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
END $$;

CREATE FUNCTION users_profile_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME = 'users' THEN
        PERFORM assert_user_has_profile(NEW.id);
    ELSE
        PERFORM assert_user_has_profile(OLD.user_id);
    END IF;
    RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER users_total_specialization
    AFTER INSERT OR UPDATE OF role ON users
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION users_profile_check();
CREATE CONSTRAINT TRIGGER citizen_profile_removed AFTER DELETE ON citizen_profiles
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION users_profile_check();
CREATE CONSTRAINT TRIGGER officer_profile_removed AFTER DELETE ON officer_profiles
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION users_profile_check();
CREATE CONSTRAINT TRIGGER admin_profile_removed AFTER DELETE ON admin_profiles
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION users_profile_check();

-- Convenience view: one row per user with the role-specific columns.
CREATE VIEW v_users AS
SELECT u.id, u.email, u.full_name, u.phone, u.role, u.status, u.preferred_language,
       u.email_verified_at, u.last_active_at, u.created_at, u.deleted_at,
       coalesce(o.department_id, a.department_id) AS department_id,
       o.team_id, coalesce(o.employee_no, a.employee_no) AS employee_no,
       o.position_title, o.is_supervisor, a.access_level,
       c.home_suburb, c.default_anonymous
FROM users u
LEFT JOIN citizen_profiles c ON c.user_id = u.id
LEFT JOIN officer_profiles o ON o.user_id = u.id
LEFT JOIN admin_profiles   a ON a.user_id = u.id;

-- Email verification and password reset links (S2, S3, A6 "send reset email").
-- Only a SHA-256 hash of the token is stored.
CREATE TABLE auth_tokens (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose     auth_token_purpose NOT NULL,
    token_hash  bytea       NOT NULL UNIQUE,
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_user_idx ON auth_tokens (user_id, purpose);

-- Staff invitations (A2 "Invite officer"). Accepting creates/activates the user.
CREATE TABLE staff_invitations (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    email         citext      NOT NULL,
    role          user_role   NOT NULL CHECK (role IN ('officer', 'admin')),
    employee_no   text        NOT NULL,
    department_id smallint    REFERENCES departments(id),
    team_id       smallint    REFERENCES teams(id),
    token_hash    bytea       NOT NULL UNIQUE,
    invited_by    uuid        NOT NULL REFERENCES users(id),
    expires_at    timestamptz NOT NULL,
    accepted_at   timestamptz,
    accepted_user_id uuid     REFERENCES users(id),
    revoked_at    timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX staff_invitations_open_email
    ON staff_invitations (email) WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Refresh-token sessions (sign out everywhere, revoke on deactivate).
CREATE TABLE user_sessions (
    id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash bytea       NOT NULL UNIQUE,
    user_agent         text,
    ip_address         inet,
    created_at         timestamptz NOT NULL DEFAULT now(),
    last_used_at       timestamptz NOT NULL DEFAULT now(),
    expires_at         timestamptz NOT NULL,
    revoked_at         timestamptz
);
CREATE INDEX user_sessions_user_idx ON user_sessions (user_id) WHERE revoked_at IS NULL;

-- Push tokens for the mobile app.
CREATE TABLE device_push_tokens (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform    text        NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
    token       text        NOT NULL UNIQUE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now()
);

-- Per-event channel preferences (C8 toggle, O6 matrix). Missing row = default on.
CREATE TABLE notification_preferences (
    user_id   uuid               NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event     notification_event NOT NULL,
    in_app    boolean            NOT NULL DEFAULT true,
    email     boolean            NOT NULL DEFAULT true,
    push      boolean            NOT NULL DEFAULT true,
    PRIMARY KEY (user_id, event)
);

-- -----------------------------------------------------------------------------
-- 5. Categories and SLAs  (FR-23, A3)
-- -----------------------------------------------------------------------------
CREATE TABLE categories (
    id                    smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    parent_id             smallint    REFERENCES categories(id),   -- "Roads" → "Pothole"
    name                  text        NOT NULL,
    slug                  text        NOT NULL UNIQUE,
    description           text,
    default_department_id smallint    NOT NULL REFERENCES departments(id),
    default_team_id       smallint    REFERENCES teams(id),
    sla_days              smallint    NOT NULL DEFAULT 5 CHECK (sla_days BETWEEN 1 AND 365),
    icon                  text,
    sort_order            smallint    NOT NULL DEFAULT 0,
    is_active             boolean     NOT NULL DEFAULT true,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (parent_id, name)
);

-- "Keywords that help the AI" (A3). One row per keyword (1NF, was an array in v1).
CREATE TABLE category_keywords (
    category_id smallint NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    keyword     citext   NOT NULL CHECK (char_length(keyword) BETWEEN 2 AND 60),
    PRIMARY KEY (category_id, keyword)
);
CREATE INDEX category_keywords_keyword_idx ON category_keywords (keyword);

-- Optional tighter SLA by priority (e.g. critical = 1 day). Overrides sla_days.
CREATE TABLE sla_priority_overrides (
    category_id smallint       NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    priority    priority_level NOT NULL,
    sla_hours   integer        NOT NULL CHECK (sla_hours > 0),
    PRIMARY KEY (category_id, priority)
);

-- -----------------------------------------------------------------------------
-- 6. Incidents  (FR-05 … FR-12, FR-17, FR-18)
-- -----------------------------------------------------------------------------
-- Per-year counter for INC-YYYY-NNNNN numbers (D6).
CREATE TABLE incident_number_counters (
    year       smallint PRIMARY KEY,
    last_value integer  NOT NULL DEFAULT 0
);

CREATE TABLE incidents (
    id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reference_no           text        NOT NULL UNIQUE,        -- INC-2026-00042 (FR-08)
    title                  text        NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
    description            text        NOT NULL CHECK (char_length(description) BETWEEN 10 AND 4000),

    -- Who reported it
    reporter_id            uuid        NOT NULL REFERENCES users(id),
    is_anonymous           boolean     NOT NULL DEFAULT false,  -- D3

    -- Where and when (FR-05, FR-07)
    location               geography(Point, 4326) NOT NULL,
    location_accuracy_m    real,
    address                text,
    ward_id                smallint    REFERENCES wards(id),    -- set by trigger
    occurred_at            timestamptz NOT NULL DEFAULT now(),  -- "Date seen" + "Time"

    -- Classification. category/priority are the FINAL values; AI suggestions
    -- are kept in ai_predictions and mirrored here for fast listing (FR-25/26/28).
    category_id            smallint    NOT NULL REFERENCES categories(id),
    priority               priority_level NOT NULL DEFAULT 'medium',
    ai_category_id         smallint    REFERENCES categories(id),
    ai_priority            priority_level,
    ai_priority_reason     text,
    ai_confidence          numeric(4,3) CHECK (ai_confidence BETWEEN 0 AND 1),
    category_source        text        NOT NULL DEFAULT 'citizen'
                           CHECK (category_source IN ('citizen', 'ai', 'staff')),
    priority_source        text        NOT NULL DEFAULT 'default'
                           CHECK (priority_source IN ('default', 'ai', 'staff')),
    ai_summary             text,                                -- FR-27, O2
    ai_summary_updated_at  timestamptz,

    -- Workflow (FR-10, FR-11)
    status                 incident_status NOT NULL DEFAULT 'new',
    assigned_department_id smallint    REFERENCES departments(id),
    assigned_team_id       smallint    REFERENCES teams(id),
    assigned_officer_id    uuid        REFERENCES users(id),
    sla_due_at             timestamptz,                         -- set by trigger
    first_reviewed_at      timestamptz,
    assigned_at            timestamptz,
    work_started_at        timestamptz,
    resolved_at            timestamptz,
    closed_at              timestamptz,
    resolution_note        text,
    closure_reason         closure_reason,
    reopen_count           smallint    NOT NULL DEFAULT 0,

    -- Duplicates (D2)
    merged_into_id         bigint      REFERENCES incidents(id),
    supporter_count        integer     NOT NULL DEFAULT 0,       -- "I see this too"

    is_public              boolean     NOT NULL DEFAULT true,    -- shown on C3 map
    search_vector          tsvector GENERATED ALWAYS AS (
                               setweight(to_tsvector('english', coalesce(reference_no, '')), 'A') ||
                               setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
                               setweight(to_tsvector('english', coalesce(address, '')), 'B') ||
                               setweight(to_tsvector('english', coalesce(description, '')), 'C')
                           ) STORED,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    deleted_at             timestamptz,

    CONSTRAINT incidents_closed_needs_reason
        CHECK (status NOT IN ('closed', 'rejected') OR closure_reason IS NOT NULL),
    CONSTRAINT incidents_duplicate_needs_target
        CHECK (coalesce(closure_reason = 'duplicate', false) = (merged_into_id IS NOT NULL)),
    CONSTRAINT incidents_not_merged_into_self
        CHECK (merged_into_id IS NULL OR merged_into_id <> id),
    CONSTRAINT incidents_assigned_needs_owner
        CHECK (status NOT IN ('assigned', 'in_progress')
               OR assigned_team_id IS NOT NULL OR assigned_officer_id IS NOT NULL),
    CONSTRAINT incidents_occurred_not_future
        CHECK (occurred_at <= created_at + interval '5 minutes')
);

CREATE INDEX incidents_location_gix   ON incidents USING gist (location);
CREATE INDEX incidents_status_idx     ON incidents (status, priority, created_at);
CREATE INDEX incidents_open_queue_idx ON incidents (assigned_department_id, priority DESC, created_at)
    WHERE status IN ('new', 'under_review', 'assigned', 'in_progress') AND deleted_at IS NULL;
CREATE INDEX incidents_officer_idx    ON incidents (assigned_officer_id) WHERE status NOT IN ('closed', 'rejected');
CREATE INDEX incidents_reporter_idx   ON incidents (reporter_id, created_at DESC);
CREATE INDEX incidents_category_idx   ON incidents (category_id, created_at);
CREATE INDEX incidents_ward_idx       ON incidents (ward_id, created_at);
CREATE INDEX incidents_sla_idx        ON incidents (sla_due_at) WHERE status NOT IN ('resolved', 'closed', 'rejected');
CREATE INDEX incidents_merged_idx     ON incidents (merged_into_id) WHERE merged_into_id IS NOT NULL;
CREATE INDEX incidents_search_gin     ON incidents USING gin (search_vector);
CREATE INDEX incidents_title_trgm     ON incidents USING gin (title gin_trgm_ops);

-- Which status moves are legal (D1). Edit rows, not code, to change the flow.
CREATE TABLE incident_status_transitions (
    from_status    incident_status NOT NULL,
    to_status      incident_status NOT NULL,
    allowed_roles  user_role[]     NOT NULL,
    description    text,
    PRIMARY KEY (from_status, to_status)
);

-- Citizen-visible timeline (FR-12, C5 tracker, O2 activity).
CREATE TABLE incident_status_history (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    incident_id   bigint          NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    from_status   incident_status,
    to_status     incident_status NOT NULL,
    changed_by    uuid            REFERENCES users(id),     -- NULL = system (auto-close)
    note          text,                                     -- "Note to citizen"
    is_public     boolean         NOT NULL DEFAULT true,
    created_at    timestamptz     NOT NULL DEFAULT now()
);
CREATE INDEX incident_status_history_idx ON incident_status_history (incident_id, created_at);

-- Assignment history (FR-11, A5 bulk assign, "Incident reassigned").
CREATE TABLE incident_assignments (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    incident_id   bigint      NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    department_id smallint    REFERENCES departments(id),
    team_id       smallint    REFERENCES teams(id),
    officer_id    uuid        REFERENCES users(id),
    assigned_by   uuid        REFERENCES users(id),
    reason        text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    ended_at      timestamptz
);
CREATE INDEX incident_assignments_idx ON incident_assignments (incident_id, created_at);

-- "I see this too" (C3). One vote per citizen per incident.
CREATE TABLE incident_supporters (
    incident_id bigint      NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    comment     text,
    location    geography(Point, 4326),
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (incident_id, user_id)
);

-- Officer ↔ citizen messages on a report (FR-14, C10, O2 "Message citizen").
-- is_internal = staff-only note, never shown to the citizen.
CREATE TABLE incident_messages (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    incident_id  bigint      NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    sender_id    uuid        NOT NULL REFERENCES users(id),
    body         text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
    is_internal  boolean     NOT NULL DEFAULT false,
    read_at      timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    edited_at    timestamptz,
    deleted_at   timestamptz
);
CREATE INDEX incident_messages_idx ON incident_messages (incident_id, created_at);

-- Photos and files (FR-06: up to 3 citizen photos, JPG/PNG, 5 MB each).
-- Files live in object storage (S3 / Supabase / MinIO); only the key is here.
CREATE TABLE incident_attachments (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id   bigint      NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    message_id    bigint      REFERENCES incident_messages(id) ON DELETE CASCADE,
    uploaded_by   uuid        NOT NULL REFERENCES users(id),
    kind          attachment_kind NOT NULL DEFAULT 'citizen_photo',
    storage_key   text        NOT NULL UNIQUE,
    thumbnail_key text,
    mime_type     text        NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png')),
    size_bytes    integer     NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5 * 1024 * 1024),
    width_px      integer,
    height_px     integer,
    sha256        bytea,
    exif_stripped boolean     NOT NULL DEFAULT false,   -- remove GPS/camera metadata
    moderation    moderation_status NOT NULL DEFAULT 'pending',
    sort_order    smallint    NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT attachments_message_kind
        CHECK ((kind = 'message_attachment') = (message_id IS NOT NULL))
);
CREATE INDEX incident_attachments_idx ON incident_attachments (incident_id, kind, sort_order);

-- Citizen rating after a fix (FR-15, C11). One per incident per resolution cycle.
CREATE TABLE incident_ratings (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    incident_id      bigint      NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    citizen_id       uuid        NOT NULL REFERENCES users(id),
    resolution_cycle smallint    NOT NULL DEFAULT 0,      -- = incidents.reopen_count at rating time
    score            smallint    NOT NULL CHECK (score BETWEEN 1 AND 5),
    comment          text        CHECK (char_length(comment) <= 1000),
    requested_reopen boolean     NOT NULL DEFAULT false,
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (incident_id, resolution_cycle)
);

-- Quick-feedback chips on C11 ("Fixed quickly", "Not fully fixed"…). Lookup + junction (was an array in v1).
CREATE TABLE feedback_tags (
    code        text     PRIMARY KEY,
    label       text     NOT NULL,
    is_positive boolean  NOT NULL,
    sort_order  smallint NOT NULL DEFAULT 0
);
CREATE TABLE incident_rating_tags (
    rating_id bigint NOT NULL REFERENCES incident_ratings(id) ON DELETE CASCADE,
    tag_code  text   NOT NULL REFERENCES feedback_tags(code),
    PRIMARY KEY (rating_id, tag_code)
);

-- -----------------------------------------------------------------------------
-- 7. Notifications  (FR-13, C6, O5)
-- -----------------------------------------------------------------------------
CREATE TABLE notifications (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      uuid               NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event        notification_event NOT NULL,
    incident_id  bigint             REFERENCES incidents(id) ON DELETE CASCADE,
    title        text               NOT NULL,
    body         text,
    data         jsonb              NOT NULL DEFAULT '{}',
    read_at      timestamptz,
    created_at   timestamptz        NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_unread_idx ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX notifications_user_idx        ON notifications (user_id, created_at DESC);

-- Outbox for email/push. A worker picks 'queued' rows (FOR UPDATE SKIP LOCKED).
CREATE TABLE notification_deliveries (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    notification_id  bigint               NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    channel          notification_channel NOT NULL,
    status           delivery_status      NOT NULL DEFAULT 'queued',
    attempts         smallint             NOT NULL DEFAULT 0,
    next_attempt_at  timestamptz          NOT NULL DEFAULT now(),
    provider_message_id text,
    last_error       text,
    sent_at          timestamptz,
    created_at       timestamptz          NOT NULL DEFAULT now(),
    UNIQUE (notification_id, channel)
);
CREATE INDEX notification_deliveries_queue_idx
    ON notification_deliveries (next_attempt_at) WHERE status = 'queued';

-- -----------------------------------------------------------------------------
-- 8. AI  (FR-25 … FR-30, A4)
-- -----------------------------------------------------------------------------
-- One row per AI feature; admins switch features on/off (FR-30 manual fallback).
CREATE TABLE ai_settings (
    feature                 ai_feature  PRIMARY KEY,
    is_enabled              boolean     NOT NULL DEFAULT true,
    auto_apply_threshold    numeric(4,3) CHECK (auto_apply_threshold BETWEEN 0 AND 1),
    model_name              text,
    config                  jsonb       NOT NULL DEFAULT '{}',   -- welcome msg, hand-over rule, sources…
    updated_by              uuid        REFERENCES users(id),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

-- Every AI call and what humans did with it (FR-28, A8 "AI accuracy").
CREATE TABLE ai_predictions (
    id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    feature               ai_feature    NOT NULL,
    incident_id           bigint        REFERENCES incidents(id) ON DELETE CASCADE,
    model_name            text,
    model_version         text,
    prompt_version        text,
    input_hash            bytea,
    output                jsonb         NOT NULL DEFAULT '{}',
    suggested_category_id smallint      REFERENCES categories(id),
    suggested_priority    priority_level,
    reason                text,
    confidence            numeric(4,3)  CHECK (confidence BETWEEN 0 AND 1),
    run_status            ai_run_status NOT NULL,
    error_message         text,
    latency_ms            integer,
    tokens_in             integer,
    tokens_out            integer,
    decision              ai_decision   NOT NULL DEFAULT 'pending',
    decided_by            uuid          REFERENCES users(id),
    decided_at            timestamptz,
    final_category_id     smallint      REFERENCES categories(id),
    final_priority        priority_level,
    created_at            timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX ai_predictions_incident_idx ON ai_predictions (incident_id, feature, created_at DESC);
CREATE INDEX ai_predictions_feature_idx  ON ai_predictions (feature, created_at);

-- AI monthly / periodic summaries for the admin dashboard (A1).
CREATE TABLE analytics_summaries (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    period_start  date        NOT NULL,
    period_end    date        NOT NULL,
    ward_id       smallint    REFERENCES wards(id),
    body          text        NOT NULL,
    prediction_id bigint      REFERENCES ai_predictions(id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    CHECK (period_end >= period_start)
);
CREATE UNIQUE INDEX analytics_summaries_period_uq
    ON analytics_summaries (period_start, period_end, coalesce(ward_id, 0));

-- Help chatbot (FR-29, C7) incl. hand-over to a person.
CREATE TABLE chat_conversations (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    citizen_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    incident_id      bigint      REFERENCES incidents(id) ON DELETE SET NULL,
    status           chat_status NOT NULL DEFAULT 'bot',
    report_draft     jsonb,          -- chatbot-guided report: {title, description, lat, lng, category_id}
    handover_reason  text,
    handover_at      timestamptz,
    staff_id         uuid        REFERENCES users(id),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    closed_at        timestamptz
);
CREATE INDEX chat_conversations_citizen_idx ON chat_conversations (citizen_id, created_at DESC);
CREATE INDEX chat_conversations_waiting_idx ON chat_conversations (handover_at)
    WHERE status = 'waiting_for_staff';

CREATE TABLE chat_messages (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    conversation_id  uuid        NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    sender           chat_sender NOT NULL,
    sender_user_id   uuid        REFERENCES users(id),
    body             text        NOT NULL,
    payload          jsonb,          -- e.g. {"type":"status_card","incident_id":42}
    prediction_id    bigint      REFERENCES ai_predictions(id),
    created_at       timestamptz NOT NULL DEFAULT now(),
    CHECK ((sender IN ('citizen', 'staff')) = (sender_user_id IS NOT NULL))
);
CREATE INDEX chat_messages_conv_idx ON chat_messages (conversation_id, created_at);

-- FAQ content used by C8 "Help and FAQ" and as chatbot knowledge.
CREATE TABLE faq_articles (
    id           smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    question     text        NOT NULL,
    answer       text        NOT NULL,
    language     text        NOT NULL DEFAULT 'en',
    category_id  smallint    REFERENCES categories(id),
    is_published boolean     NOT NULL DEFAULT true,
    sort_order   smallint    NOT NULL DEFAULT 0,
    updated_by   uuid        REFERENCES users(id),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 9. Admin: feedback, exports, settings, audit  (C8, FR-16, FR-24, A7, A8)
-- -----------------------------------------------------------------------------
CREATE TABLE app_feedback (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     uuid            REFERENCES users(id) ON DELETE SET NULL,
    body        text            NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
    app_version text,
    platform    text,
    status      feedback_status NOT NULL DEFAULT 'new',
    created_at  timestamptz     NOT NULL DEFAULT now()
);

CREATE TABLE export_jobs (
    id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    requested_by  uuid          NOT NULL REFERENCES users(id),
    report_type   text          NOT NULL CHECK (report_type IN (
                                  'incident_summary', 'sla_performance', 'category_trends',
                                  'department_workload', 'citizen_satisfaction',
                                  'ai_accuracy', 'incident_list', 'audit_log')),
    filters       jsonb         NOT NULL DEFAULT '{}',
    format        export_format NOT NULL,
    status        export_status NOT NULL DEFAULT 'queued',
    file_key      text,
    row_count     integer,
    error_message text,
    created_at    timestamptz   NOT NULL DEFAULT now(),
    completed_at  timestamptz,
    expires_at    timestamptz
);
CREATE INDEX export_jobs_user_idx ON export_jobs (requested_by, created_at DESC);

-- Key/value settings, e.g. auto_close_days, duplicate_radius_m.
CREATE TABLE system_settings (
    key         text        PRIMARY KEY,
    value       jsonb       NOT NULL,
    description text,
    updated_by  uuid        REFERENCES users(id),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Append-only audit log (FR-16, A7). Before/after kept as JSON.
CREATE TABLE audit_logs (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_id     uuid        REFERENCES users(id),        -- NULL = system
    action       text        NOT NULL,                   -- 'status_changed', 'role_changed', 'ai_overridden' …
    entity_type  text        NOT NULL,                   -- 'incident', 'user', 'category', 'ai_settings' …
    entity_id    text        NOT NULL,
    before_data  jsonb,
    after_data   jsonb,
    ip_address   inet,
    user_agent   text,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX audit_logs_actor_idx  ON audit_logs (actor_id, created_at DESC);
CREATE INDEX audit_logs_time_idx   ON audit_logs (created_at DESC);

CREATE FUNCTION audit_logs_block_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs is append-only';
END $$;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION audit_logs_block_changes();

-- -----------------------------------------------------------------------------
-- 10. Business-rule triggers
-- -----------------------------------------------------------------------------
-- The application sets these per transaction so triggers know who acted:
--   SET LOCAL app.user_id = '<uuid>';  SET LOCAL app.role = 'officer';
CREATE FUNCTION app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;
CREATE FUNCTION app_role() RETURNS user_role
LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('app.role', true), '')::user_role
$$;

-- 10.1 Incident number INC-YYYY-NNNNN, concurrency-safe.
CREATE FUNCTION next_incident_reference(p_at timestamptz DEFAULT now()) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
    v_year smallint := extract(year FROM p_at AT TIME ZONE 'Australia/Sydney');
    v_next integer;
BEGIN
    INSERT INTO incident_number_counters AS c (year, last_value)
    VALUES (v_year, 1)
    ON CONFLICT (year) DO UPDATE SET last_value = c.last_value + 1
    RETURNING last_value INTO v_next;
    RETURN format('INC-%s-%s', v_year, lpad(v_next::text, 5, '0'));
END $$;

-- 10.2 Before insert: number, ward, routing, SLA.
CREATE FUNCTION incidents_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_cat categories%ROWTYPE;
BEGIN
    IF NEW.reference_no IS NULL THEN
        NEW.reference_no := next_incident_reference(NEW.created_at);
    END IF;

    SELECT * INTO v_cat FROM categories WHERE id = NEW.category_id;
    NEW.assigned_department_id := coalesce(NEW.assigned_department_id, v_cat.default_department_id);
    RETURN NEW;
END $$;
CREATE TRIGGER incidents_bi BEFORE INSERT ON incidents
    FOR EACH ROW EXECUTE FUNCTION incidents_before_insert();

-- 10.3 Ward lookup whenever the location changes.
CREATE FUNCTION incidents_set_ward() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    SELECT w.id INTO NEW.ward_id
    FROM wards w
    WHERE ST_Covers(w.boundary, NEW.location::geometry)
    ORDER BY ST_Area(w.boundary)
    LIMIT 1;
    RETURN NEW;
END $$;
CREATE TRIGGER incidents_ward BEFORE INSERT OR UPDATE OF location ON incidents
    FOR EACH ROW EXECUTE FUNCTION incidents_set_ward();

-- 10.4 SLA due date from category (or priority override).
CREATE FUNCTION incidents_set_sla() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_hours integer;
BEGIN
    SELECT o.sla_hours INTO v_hours
    FROM sla_priority_overrides o
    WHERE o.category_id = NEW.category_id AND o.priority = NEW.priority;

    IF v_hours IS NULL THEN
        SELECT c.sla_days * 24 INTO v_hours FROM categories c WHERE c.id = NEW.category_id;
    END IF;

    NEW.sla_due_at := NEW.created_at + make_interval(hours => v_hours);
    RETURN NEW;
END $$;
CREATE TRIGGER incidents_sla BEFORE INSERT OR UPDATE OF category_id, priority ON incidents
    FOR EACH ROW EXECUTE FUNCTION incidents_set_sla();

-- 10.5 Status changes: validate, stamp times, write history.
CREATE FUNCTION incidents_status_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_role  user_role := app_role();
    v_rule  incident_status_transitions%ROWTYPE;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        SELECT * INTO v_rule FROM incident_status_transitions
        WHERE from_status = OLD.status AND to_status = NEW.status;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Status change % → % is not allowed', OLD.status, NEW.status
                USING ERRCODE = 'check_violation';
        END IF;
        -- NULL role = trusted backend job (scheduler, migrations).
        IF v_role IS NOT NULL AND NOT (v_role = ANY (v_rule.allowed_roles)) THEN
            RAISE EXCEPTION 'Role % may not move an incident from % to %', v_role, OLD.status, NEW.status
                USING ERRCODE = 'insufficient_privilege';
        END IF;

        -- Reopen: resolved → in_progress
        IF OLD.status = 'resolved' AND NEW.status = 'in_progress' THEN
            NEW.reopen_count := OLD.reopen_count + 1;
            NEW.resolved_at  := NULL;
        END IF;
        -- Leaving closed/rejected (admin reconsiders): clear closure fields
        IF OLD.status = 'rejected' THEN
            NEW.closure_reason := NULL;
            NEW.closed_at      := NULL;
        END IF;
    END IF;

    CASE NEW.status
        WHEN 'under_review' THEN NEW.first_reviewed_at := coalesce(NEW.first_reviewed_at, now());
        WHEN 'assigned'     THEN NEW.assigned_at       := now();
        WHEN 'in_progress'  THEN NEW.work_started_at   := coalesce(NEW.work_started_at, now());
        WHEN 'resolved'     THEN NEW.resolved_at       := now();
        WHEN 'closed'       THEN NEW.closed_at         := now();
        WHEN 'rejected'     THEN NEW.closed_at         := now();
        ELSE NULL;
    END CASE;
    RETURN NEW;
END $$;
CREATE TRIGGER incidents_status BEFORE INSERT OR UPDATE OF status ON incidents
    FOR EACH ROW EXECUTE FUNCTION incidents_status_change();

CREATE FUNCTION incidents_status_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO incident_status_history (incident_id, from_status, to_status, changed_by, note)
        VALUES (NEW.id,
                CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END,
                NEW.status,
                coalesce(app_user_id(), CASE WHEN TG_OP = 'INSERT' THEN NEW.reporter_id END),
                nullif(current_setting('app.status_note', true), ''));

        INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, before_data, after_data)
        VALUES (app_user_id(),
                CASE WHEN TG_OP = 'INSERT' THEN 'incident_created' ELSE 'status_changed' END,
                'incident', NEW.id::text,
                CASE WHEN TG_OP = 'UPDATE' THEN jsonb_build_object('status', OLD.status) END,
                jsonb_build_object('status', NEW.status, 'reference_no', NEW.reference_no));
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER incidents_status_hist AFTER INSERT OR UPDATE OF status ON incidents
    FOR EACH ROW EXECUTE FUNCTION incidents_status_history();

-- 10.6 Assignment history + audit.
CREATE FUNCTION incidents_assignment_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.assigned_department_id, NEW.assigned_team_id, NEW.assigned_officer_id)
       IS DISTINCT FROM (OLD.assigned_department_id, OLD.assigned_team_id, OLD.assigned_officer_id) THEN
        UPDATE incident_assignments SET ended_at = now()
        WHERE incident_id = NEW.id AND ended_at IS NULL;

        INSERT INTO incident_assignments (incident_id, department_id, team_id, officer_id, assigned_by)
        VALUES (NEW.id, NEW.assigned_department_id, NEW.assigned_team_id, NEW.assigned_officer_id, app_user_id());

        INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, before_data, after_data)
        VALUES (app_user_id(), 'assignment_changed', 'incident', NEW.id::text,
                jsonb_build_object('department_id', OLD.assigned_department_id,
                                   'team_id', OLD.assigned_team_id, 'officer_id', OLD.assigned_officer_id),
                jsonb_build_object('department_id', NEW.assigned_department_id,
                                   'team_id', NEW.assigned_team_id, 'officer_id', NEW.assigned_officer_id));
    END IF;

    IF (NEW.category_id, NEW.priority) IS DISTINCT FROM (OLD.category_id, OLD.priority) THEN
        INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, before_data, after_data)
        VALUES (app_user_id(),
                CASE WHEN NEW.category_source = 'staff' OR NEW.priority_source = 'staff'
                     THEN 'ai_overridden' ELSE 'classification_changed' END,
                'incident', NEW.id::text,
                jsonb_build_object('category_id', OLD.category_id, 'priority', OLD.priority),
                jsonb_build_object('category_id', NEW.category_id, 'priority', NEW.priority,
                                   'ai_category_id', NEW.ai_category_id, 'ai_priority', NEW.ai_priority));
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER incidents_assignment AFTER UPDATE ON incidents
    FOR EACH ROW EXECUTE FUNCTION incidents_assignment_change();

-- 10.6b Citizens may only change the status of their own report
--       (confirm fix or reopen); everything else is staff-only.
CREATE FUNCTION incidents_citizen_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_ignore text[] := ARRAY['status', 'closure_reason', 'updated_at', 'closed_at',
                             'resolved_at', 'work_started_at', 'reopen_count',
                             'supporter_count', 'search_vector'];
BEGIN
    IF app_role() = 'citizen'
       AND (to_jsonb(NEW) - v_ignore) IS DISTINCT FROM (to_jsonb(OLD) - v_ignore) THEN
        RAISE EXCEPTION 'Citizens can only confirm or reopen their report'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER incidents_zz_citizen_guard BEFORE UPDATE ON incidents
    FOR EACH ROW EXECUTE FUNCTION incidents_citizen_guard();

CREATE TRIGGER incidents_updated_at BEFORE UPDATE ON incidents
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 10.7 Max 3 citizen photos per incident (FR-06).
CREATE FUNCTION attachments_limit_photos() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.kind = 'citizen_photo' AND
       (SELECT count(*) FROM incident_attachments
        WHERE incident_id = NEW.incident_id AND kind = 'citizen_photo'
          AND uploaded_by = NEW.uploaded_by) >= 3 THEN
        RAISE EXCEPTION 'A report can have at most 3 photos' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER incident_attachments_limit BEFORE INSERT ON incident_attachments
    FOR EACH ROW EXECUTE FUNCTION attachments_limit_photos();

-- 10.8 Supporter counter ("I see this too").
CREATE FUNCTION supporters_count() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    UPDATE incidents SET supporter_count = supporter_count + CASE WHEN TG_OP = 'INSERT' THEN 1 ELSE -1 END
    WHERE id = coalesce(NEW.incident_id, OLD.incident_id);
    RETURN NULL;
END $$;
CREATE TRIGGER incident_supporters_count AFTER INSERT OR DELETE ON incident_supporters
    FOR EACH ROW EXECUTE FUNCTION supporters_count();

-- 10.9 Rating rules: only the reporter, only when resolved.
CREATE FUNCTION ratings_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_inc incidents%ROWTYPE;
BEGIN
    SELECT * INTO v_inc FROM incidents WHERE id = NEW.incident_id;
    IF v_inc.reporter_id <> NEW.citizen_id THEN
        RAISE EXCEPTION 'Only the reporter can rate this incident';
    END IF;
    IF v_inc.status <> 'resolved' THEN
        RAISE EXCEPTION 'An incident can only be rated once it is resolved';
    END IF;
    NEW.resolution_cycle := v_inc.reopen_count;
    RETURN NEW;
END $$;
CREATE TRIGGER incident_ratings_check BEFORE INSERT ON incident_ratings
    FOR EACH ROW EXECUTE FUNCTION ratings_check();

-- updated_at on the other mutable tables
CREATE TRIGGER departments_updated_at BEFORE UPDATE ON departments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER teams_updated_at       BEFORE UPDATE ON teams       FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER wards_updated_at       BEFORE UPDATE ON wards       FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_updated_at       BEFORE UPDATE ON users       FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER citizen_profiles_updated_at BEFORE UPDATE ON citizen_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER officer_profiles_updated_at BEFORE UPDATE ON officer_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER admin_profiles_updated_at   BEFORE UPDATE ON admin_profiles   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER categories_updated_at  BEFORE UPDATE ON categories  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER chat_conv_updated_at   BEFORE UPDATE ON chat_conversations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER faq_updated_at         BEFORE UPDATE ON faq_articles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 11. Workflow functions called by the API / scheduler
-- -----------------------------------------------------------------------------
-- Create an in-app notification and queue email/push per the user's
-- preferences. SECURITY DEFINER so a citizen's action (e.g. a message) can
-- notify an officer without opening the notifications table to citizens.
CREATE FUNCTION create_notification(p_user uuid, p_event notification_event, p_title text,
                                    p_body text DEFAULT NULL, p_incident bigint DEFAULT NULL,
                                    p_data jsonb DEFAULT '{}')
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_id    bigint;
    v_pref  notification_preferences%ROWTYPE;
    v_has   boolean;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_user AND deleted_at IS NULL AND status <> 'inactive') THEN
        RETURN NULL;
    END IF;
    INSERT INTO notifications (user_id, event, incident_id, title, body, data)
    VALUES (p_user, p_event, p_incident, p_title, p_body, coalesce(p_data, '{}'))
    RETURNING id INTO v_id;

    SELECT * INTO v_pref FROM notification_preferences WHERE user_id = p_user AND event = p_event;
    v_has := FOUND;
    IF NOT v_has OR v_pref.email THEN
        INSERT INTO notification_deliveries (notification_id, channel) VALUES (v_id, 'email');
    END IF;
    IF (NOT v_has OR v_pref.push) AND EXISTS (SELECT 1 FROM device_push_tokens WHERE user_id = p_user) THEN
        INSERT INTO notification_deliveries (notification_id, channel) VALUES (v_id, 'push');
    END IF;
    RETURN v_id;
END $$;

-- Move a user to another role (A6). Old profile out, role changed, new profile in,
-- all in one transaction so the specialization stays disjoint and total.
CREATE FUNCTION change_user_role(p_user uuid, p_role user_role, p_employee_no text DEFAULT NULL,
                                 p_department smallint DEFAULT NULL, p_team smallint DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    v_old user_role;
BEGIN
    SELECT role INTO v_old FROM users WHERE id = p_user FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'User % not found', p_user; END IF;
    IF v_old = p_role THEN RETURN; END IF;
    IF p_role IN ('officer', 'admin') AND p_employee_no IS NULL THEN
        RAISE EXCEPTION 'Staff roles need an employee number';
    END IF;

    DELETE FROM citizen_profiles WHERE user_id = p_user;
    DELETE FROM officer_profiles WHERE user_id = p_user;
    DELETE FROM admin_profiles   WHERE user_id = p_user;
    UPDATE users SET role = p_role WHERE id = p_user;

    CASE p_role
        WHEN 'citizen' THEN INSERT INTO citizen_profiles (user_id) VALUES (p_user);
        WHEN 'officer' THEN INSERT INTO officer_profiles (user_id, employee_no, department_id, team_id)
                            VALUES (p_user, p_employee_no, p_department, p_team);
        WHEN 'admin'   THEN INSERT INTO admin_profiles (user_id, employee_no, department_id)
                            VALUES (p_user, p_employee_no, p_department);
    END CASE;

    INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, before_data, after_data)
    VALUES (app_user_id(), 'role_changed', 'user', p_user::text,
            jsonb_build_object('role', v_old), jsonb_build_object('role', p_role, 'department_id', p_department));
END $$;

-- Merge a duplicate into a primary incident (O2 "Merge duplicate").
CREATE FUNCTION merge_incident(p_duplicate bigint, p_primary bigint, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF p_duplicate = p_primary THEN
        RAISE EXCEPTION 'Cannot merge an incident into itself';
    END IF;
    IF EXISTS (SELECT 1 FROM incidents WHERE id = p_primary AND status IN ('closed', 'rejected')) THEN
        RAISE EXCEPTION 'Primary incident % is already closed', p_primary;
    END IF;

    PERFORM set_config('app.status_note',
                       coalesce(p_note, 'Merged into ' || (SELECT reference_no FROM incidents WHERE id = p_primary)),
                       true);
    UPDATE incidents
       SET status = 'closed', closure_reason = 'duplicate', merged_into_id = p_primary
     WHERE id = p_duplicate;

    -- The duplicate's reporter becomes a supporter of the primary.
    INSERT INTO incident_supporters (incident_id, user_id)
    SELECT p_primary, reporter_id FROM incidents WHERE id = p_duplicate
    ON CONFLICT DO NOTHING;

    PERFORM set_config('app.status_note', '', true);
END $$;

-- Close incidents left in 'resolved' with no citizen response (status flow).
-- Schedule daily with pg_cron or the app's job runner.
CREATE FUNCTION auto_close_resolved_incidents() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
    v_days integer := coalesce((SELECT (value)::text::integer FROM system_settings WHERE key = 'auto_close_days'), 7);
    v_count integer;
BEGIN
    PERFORM set_config('app.role', '', true);
    PERFORM set_config('app.status_note', 'Closed automatically: no response after ' || v_days || ' days', true);
    UPDATE incidents
       SET status = 'closed', closure_reason = 'auto_closed'
     WHERE status = 'resolved'
       AND resolved_at < now() - make_interval(days => v_days);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    PERFORM set_config('app.status_note', '', true);
    RETURN v_count;
END $$;

-- Open incidents near a point (C1 "Near you", C3 map, duplicate check).
CREATE FUNCTION incidents_nearby(p_lat double precision, p_lng double precision,
                                 p_radius_m integer DEFAULT 1000,
                                 p_category_id smallint DEFAULT NULL)
RETURNS TABLE (id bigint, reference_no text, title text, status incident_status,
               priority priority_level, category_id smallint, distance_m double precision,
               lat double precision, lng double precision)
LANGUAGE sql STABLE AS $$
    SELECT i.id, i.reference_no, i.title, i.status, i.priority, i.category_id,
           ST_Distance(i.location, ST_MakePoint(p_lng, p_lat)::geography) AS distance_m,
           ST_Y(i.location::geometry), ST_X(i.location::geometry)
    FROM incidents i
    WHERE ST_DWithin(i.location, ST_MakePoint(p_lng, p_lat)::geography, p_radius_m)
      AND i.is_public AND i.deleted_at IS NULL
      AND i.status NOT IN ('closed', 'rejected')
      AND (p_category_id IS NULL OR i.category_id = p_category_id)
    ORDER BY distance_m
$$;

-- Likely duplicates for a new report: same category, close by, recent.
CREATE FUNCTION find_duplicate_candidates(p_incident bigint)
RETURNS TABLE (id bigint, reference_no text, title text, distance_m double precision,
               similarity real)
LANGUAGE sql STABLE AS $$
    SELECT o.id, o.reference_no, o.title,
           ST_Distance(o.location, n.location),
           similarity(o.title, n.title)
    FROM incidents n
    JOIN incidents o ON o.id <> n.id
      AND o.category_id = n.category_id
      AND o.status NOT IN ('closed', 'rejected')
      AND o.created_at > n.created_at - interval '30 days'
      AND ST_DWithin(o.location, n.location,
            coalesce((SELECT (value)::text::integer FROM system_settings WHERE key = 'duplicate_radius_m'), 50))
    WHERE n.id = p_incident
    ORDER BY ST_Distance(o.location, n.location), similarity(o.title, n.title) DESC
    LIMIT 10
$$;

-- Heatmap cells for A1 "Hotspots" (grid in metres, returned as lat/lng).
CREATE FUNCTION incident_heatmap(p_from timestamptz, p_to timestamptz, p_cell_m integer DEFAULT 250)
RETURNS TABLE (lat double precision, lng double precision, incident_count bigint)
LANGUAGE sql STABLE AS $$
    WITH pts AS (
        SELECT ST_Transform(location::geometry, 3857) AS g
        FROM incidents
        WHERE created_at >= p_from AND created_at < p_to AND deleted_at IS NULL
    )
    SELECT ST_Y(ST_Transform(ST_Centroid(ST_SnapToGrid(g, p_cell_m)), 4326)),
           ST_X(ST_Transform(ST_Centroid(ST_SnapToGrid(g, p_cell_m)), 4326)),
           count(*)
    FROM pts
    GROUP BY ST_SnapToGrid(g, p_cell_m)
$$;

-- -----------------------------------------------------------------------------
-- 12. Read views for screens
-- -----------------------------------------------------------------------------
-- Public map (C3): no reporter identity, no rejected/merged items.
CREATE VIEW v_public_incidents AS
SELECT i.id, i.reference_no, i.title, i.status, i.priority,
       c.name AS category, i.category_id, i.address, i.ward_id,
       ST_Y(i.location::geometry) AS lat, ST_X(i.location::geometry) AS lng,
       i.status NOT IN ('resolved', 'closed') AS is_open,
       i.supporter_count, i.created_at, i.updated_at
FROM incidents i
JOIN categories c ON c.id = i.category_id
WHERE i.is_public AND i.deleted_at IS NULL
  AND i.status NOT IN ('rejected')
  AND i.merged_into_id IS NULL;

-- Officer work queue (O1, A5) sorted by AI priority then age.
CREATE VIEW v_officer_queue AS
SELECT i.id, i.reference_no, i.title, i.status, i.priority, i.ai_priority,
       i.ai_priority_reason, i.ai_confidence,
       i.category_id, c.name AS category, i.ward_id, w.name AS ward,
       i.assigned_department_id, i.assigned_team_id, t.name AS team,
       i.assigned_officer_id, u.full_name AS officer,
       CASE WHEN i.is_anonymous THEN 'Anonymous citizen' ELSE r.full_name END AS reporter,
       i.supporter_count, i.created_at, i.sla_due_at,
       CASE
           WHEN i.status IN ('resolved', 'closed', 'rejected') THEN 'done'
           WHEN i.sla_due_at < now()                         THEN 'overdue'
           WHEN i.sla_due_at < now() + interval '24 hours'   THEN 'due_soon'
           ELSE 'on_track'
       END AS sla_state
FROM incidents i
JOIN categories c ON c.id = i.category_id
JOIN users r      ON r.id = i.reporter_id
LEFT JOIN wards w ON w.id = i.ward_id
LEFT JOIN teams t ON t.id = i.assigned_team_id
LEFT JOIN users u ON u.id = i.assigned_officer_id
WHERE i.deleted_at IS NULL AND i.merged_into_id IS NULL;

-- Daily stats for analytics (A1, O4, A8). Refresh nightly or every 15 min:
--   REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_incident_stats;
CREATE MATERIALIZED VIEW mv_daily_incident_stats AS
SELECT (i.created_at AT TIME ZONE 'Australia/Sydney')::date AS day,
       i.category_id,
       coalesce(i.ward_id, 0)::smallint                 AS ward_id,        -- 0 = outside all wards
       coalesce(i.assigned_department_id, 0)::smallint  AS department_id,
       count(*)                                                    AS received,
       count(*) FILTER (WHERE i.status IN ('resolved', 'closed') AND i.closure_reason IS DISTINCT FROM 'duplicate') AS resolved,
       count(*) FILTER (WHERE i.status NOT IN ('resolved', 'closed', 'rejected')) AS still_open,
       count(*) FILTER (WHERE i.status NOT IN ('resolved', 'closed', 'rejected') AND i.sla_due_at < now()) AS past_sla,
       count(*) FILTER (WHERE i.resolved_at IS NOT NULL AND i.resolved_at <= i.sla_due_at) AS resolved_within_sla,
       avg(extract(epoch FROM i.resolved_at - i.created_at) / 86400.0)
           FILTER (WHERE i.resolved_at IS NOT NULL)                AS avg_days_to_resolve,
       avg(r.score)                                                AS avg_rating,
       coalesce(sum(r.n), 0)::bigint                               AS rating_count
FROM incidents i
LEFT JOIN LATERAL (                        -- latest rating per incident, so counts are not doubled
    SELECT x.score, 1 AS n FROM incident_ratings x
    WHERE x.incident_id = i.id ORDER BY x.created_at DESC LIMIT 1
) r ON true
WHERE i.deleted_at IS NULL
GROUP BY 1, 2, 3, 4;
CREATE UNIQUE INDEX mv_daily_incident_stats_uq
    ON mv_daily_incident_stats (day, category_id, ward_id, department_id);

-- Citizen dashboard "Feedback history" (brief §5).
CREATE VIEW v_citizen_feedback_history AS
SELECT r.citizen_id, r.id AS rating_id, i.id AS incident_id, i.reference_no, i.title,
       r.score, r.comment, r.requested_reopen, r.resolution_cycle, r.created_at,
       coalesce(array_agg(t.tag_code ORDER BY t.tag_code) FILTER (WHERE t.tag_code IS NOT NULL), '{}') AS tags
FROM incident_ratings r
JOIN incidents i ON i.id = r.incident_id
LEFT JOIN incident_rating_tags t ON t.rating_id = r.id
GROUP BY r.id, i.id;

-- Officer dashboard "Department workload" (brief §5, O4).
CREATE VIEW v_department_workload AS
SELECT d.id AS department_id, d.name AS department,
       o.user_id AS officer_id, u.full_name AS officer,
       count(i.id) FILTER (WHERE i.status IN ('assigned', 'in_progress'))          AS open_assigned,
       count(i.id) FILTER (WHERE i.status IN ('assigned', 'in_progress') AND i.sla_due_at < now()) AS overdue,
       count(i.id) FILTER (WHERE i.resolved_at > now() - interval '30 days')      AS resolved_30d,
       o.max_open_assignments
FROM departments d
JOIN officer_profiles o ON o.department_id = d.id
JOIN users u ON u.id = o.user_id AND u.deleted_at IS NULL
LEFT JOIN incidents i ON i.assigned_officer_id = o.user_id AND i.deleted_at IS NULL
GROUP BY d.id, o.user_id, u.full_name;

-- Admin dashboard "System usage statistics" (brief §5).
CREATE VIEW v_system_usage_daily AS
WITH days AS (
    SELECT generate_series((now() - interval '89 days')::date, now()::date, interval '1 day')::date AS day
)
SELECT d.day,
       (SELECT count(*) FROM users u WHERE u.created_at::date = d.day AND u.role = 'citizen') AS new_citizens,
       (SELECT count(*) FROM audit_logs a WHERE a.action = 'signed_in' AND a.created_at::date = d.day) AS sign_ins,
       (SELECT count(DISTINCT a.actor_id) FROM audit_logs a WHERE a.created_at::date = d.day) AS active_users,
       (SELECT count(*) FROM incidents i WHERE i.created_at::date = d.day) AS incidents_reported,
       (SELECT count(*) FROM chat_conversations c WHERE c.created_at::date = d.day) AS chat_sessions,
       (SELECT count(*) FROM ai_predictions p WHERE p.created_at::date = d.day) AS ai_calls,
       (SELECT count(*) FROM ai_predictions p WHERE p.created_at::date = d.day AND p.run_status <> 'success') AS ai_failures
FROM days d;

-- The API role does not own the materialized view, so it refreshes it through this.
CREATE FUNCTION refresh_incident_stats() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_incident_stats;
$$;

-- AI accuracy (A8): how often staff kept the AI suggestion.
CREATE VIEW v_ai_accuracy AS
SELECT feature, date_trunc('month', created_at) AS month,
       count(*)                                          AS predictions,
       count(*) FILTER (WHERE run_status <> 'success')   AS failures,
       count(*) FILTER (WHERE decision IN ('accepted', 'auto_applied')) AS kept,
       count(*) FILTER (WHERE decision = 'overridden')   AS overridden,
       round(100.0 * count(*) FILTER (WHERE decision IN ('accepted', 'auto_applied'))
             / nullif(count(*) FILTER (WHERE decision IN ('accepted', 'auto_applied', 'overridden')), 0), 1)
                                                         AS kept_pct
FROM ai_predictions
GROUP BY 1, 2;

-- -----------------------------------------------------------------------------
-- 13. Row-level security (FR-02) – defence in depth behind the API.
--     The API connects as role cityfix_app and runs, per request:
--       SET LOCAL app.user_id = '…'; SET LOCAL app.role = 'citizen';
-- -----------------------------------------------------------------------------
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cityfix_app') THEN
        CREATE ROLE cityfix_app LOGIN PASSWORD 'change-me';
    END IF;
END $$;
GRANT USAGE ON SCHEMA public TO cityfix_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cityfix_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cityfix_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO cityfix_app;
REVOKE UPDATE, DELETE ON audit_logs FROM cityfix_app;

CREATE FUNCTION is_staff() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT app_role() IN ('officer', 'admin') $$;

ALTER TABLE incidents            ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_messages    ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications        ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_conversations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages        ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_ratings     ENABLE ROW LEVEL SECURITY;
ALTER TABLE citizen_profiles     ENABLE ROW LEVEL SECURITY;

CREATE POLICY citizen_profiles_access ON citizen_profiles
    FOR ALL TO cityfix_app
    USING (user_id = app_user_id() OR is_staff() OR app_role() IS NULL)
    WITH CHECK (user_id = app_user_id() OR app_role() = 'admin' OR app_role() IS NULL);

-- Incidents: staff see all; citizens see public ones and their own.
CREATE POLICY incidents_staff_all ON incidents
    FOR ALL TO cityfix_app USING (is_staff()) WITH CHECK (is_staff());
CREATE POLICY incidents_citizen_read ON incidents
    FOR SELECT TO cityfix_app
    USING (app_role() = 'citizen' AND (is_public OR reporter_id = app_user_id()));
CREATE POLICY incidents_citizen_insert ON incidents
    FOR INSERT TO cityfix_app
    WITH CHECK (app_role() = 'citizen' AND reporter_id = app_user_id() AND status = 'new');
CREATE POLICY incidents_citizen_update_own ON incidents          -- e.g. confirm/reopen
    FOR UPDATE TO cityfix_app
    USING (app_role() = 'citizen' AND reporter_id = app_user_id())
    WITH CHECK (reporter_id = app_user_id());
-- Background jobs connect without app.role set:
CREATE POLICY incidents_system ON incidents
    FOR ALL TO cityfix_app USING (app_role() IS NULL) WITH CHECK (app_role() IS NULL);

-- Messages: staff see all; citizens see non-internal messages on their reports.
CREATE POLICY messages_staff ON incident_messages
    FOR ALL TO cityfix_app USING (is_staff()) WITH CHECK (is_staff());
CREATE POLICY messages_citizen_read ON incident_messages
    FOR SELECT TO cityfix_app
    USING (app_role() = 'citizen' AND NOT is_internal
           AND incident_id IN (SELECT id FROM incidents WHERE reporter_id = app_user_id()));
CREATE POLICY messages_citizen_write ON incident_messages
    FOR INSERT TO cityfix_app
    WITH CHECK (app_role() = 'citizen' AND NOT is_internal AND sender_id = app_user_id()
           AND incident_id IN (SELECT id FROM incidents WHERE reporter_id = app_user_id()));
-- citizens may mark the council's messages on their own reports as read
CREATE POLICY messages_citizen_mark_read ON incident_messages
    FOR UPDATE TO cityfix_app
    USING (app_role() = 'citizen' AND NOT is_internal
           AND incident_id IN (SELECT id FROM incidents WHERE reporter_id = app_user_id()))
    WITH CHECK (NOT is_internal);

-- Attachments: anyone who can see the incident can see approved photos.
CREATE POLICY attachments_staff ON incident_attachments
    FOR ALL TO cityfix_app USING (is_staff()) WITH CHECK (is_staff());
CREATE POLICY attachments_citizen ON incident_attachments
    FOR SELECT TO cityfix_app
    USING (app_role() = 'citizen' AND (uploaded_by = app_user_id()
           OR (moderation = 'approved' AND incident_id IN (SELECT id FROM incidents))));
CREATE POLICY attachments_citizen_insert ON incident_attachments
    FOR INSERT TO cityfix_app
    WITH CHECK (app_role() = 'citizen' AND uploaded_by = app_user_id());

-- Notifications, chats, ratings: owner only (staff see chats handed to them).
CREATE POLICY notifications_owner ON notifications
    FOR ALL TO cityfix_app USING (user_id = app_user_id() OR app_role() IS NULL)
    WITH CHECK (user_id = app_user_id() OR app_role() IS NULL OR is_staff());
CREATE POLICY chats_owner ON chat_conversations
    FOR ALL TO cityfix_app
    USING (citizen_id = app_user_id() OR is_staff() OR app_role() IS NULL)
    WITH CHECK (citizen_id = app_user_id() OR is_staff() OR app_role() IS NULL);
CREATE POLICY chat_messages_owner ON chat_messages
    FOR ALL TO cityfix_app
    USING (conversation_id IN (SELECT id FROM chat_conversations))
    WITH CHECK (conversation_id IN (SELECT id FROM chat_conversations));
CREATE POLICY ratings_policy ON incident_ratings
    FOR ALL TO cityfix_app
    USING (citizen_id = app_user_id() OR is_staff() OR app_role() IS NULL)
    WITH CHECK (citizen_id = app_user_id());

COMMIT;
