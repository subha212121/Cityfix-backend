# CityFix backend – Smart City Incident Reporting & Analytics Platform

REST API + background worker for the capstone brief: citizens report urban issues with photos and a map pin, council officers triage and resolve them, administrators run analytics. AI (OpenAI, Azure OpenAI or Gemini) suggests category and priority, summarises reports and runs a help chatbot, with a rule-based fallback when AI is off or down.

**Stack:** Node.js 22 · TypeScript · Express 5 · Zod · PostgreSQL 16+ with PostGIS 3 · local-folder or S3 file storage · Nodemailer · Vitest

## Quick start

```bash
cp .env.example .env                      # set JWT_SECRET
docker compose up -d db mailpit           # PostGIS and a mail inbox (http://localhost:8025)
npm install
npm run db:migrate                        # applies db/001_schema.sql + db/002_seed.sql
npm run db:synthetic -- --incidents 2000  # optional: realistic demo data (6 months)
npm run dev                               # API on http://localhost:3000
npm run dev:worker                        # emails, SLA alerts, auto-close, AI summaries, exports
```

Sign in as `admin@council.example` / `ChangeMe!2026` and change the password.

Photos and exports are saved under `LOCAL_STORAGE_DIR` (default `./storage`). The API hands out short-lived signed links for uploading and viewing them (`/api/v1/files/...`). For a hosted deployment, set `STORAGE_DRIVER=s3` and the `S3_*` values for AWS S3, Cloudflare R2 or another S3-compatible service. Everything at once: `docker compose up -d`.

## Tests

```bash
npm test          # 46 API tests against a real PostGIS database (recreated each run)
npm run test:sql  # 37 database rule checks (needs DATABASE_ADMIN_URL)
npm run typecheck
```

The tests need a PostgreSQL superuser at `TEST_DATABASE_ADMIN_URL` (default `postgres://postgres:postgres@localhost:5432/postgres`).

## Layout

```
db/001_schema.sql     tables, enums, triggers, functions, views, row-level security
db/002_seed.sql       departments, crews, wards, the brief's 6 categories (+22 subcategories), workflow, AI settings, admin
db/tests.sql          database rule checks
src/app.ts            Express app, routes under /api/v1
src/modules/*         auth, me, uploads, incidents (+ /ai/suggest), map, chat, notifications, dashboard, admin, exports, meta
src/ai/*              provider adapter (OpenAI / Azure / Gemini), prompts, fallback rules
src/jobs/*            worker jobs; src/worker.ts schedules them
scripts/*             migrate, synthetic data generator
tests/*               API tests
```

## Key rules (enforced in the database, not just the API)

- Every user is exactly one of citizen / officer / admin, each with its own profile table (EERD specialization: disjoint and total).
- Status moves follow `incident_status_transitions`; a citizen can only confirm or reopen their own resolved report.
- Up to 3 JPG/PNG photos per report, 5 MB each; incident numbers `INC-YYYY-NNNNN`; ward and SLA set from location and category.
- Row-level security: citizens see public incidents and their own; internal notes never reach citizens.
- The API sets `app.user_id` / `app.role` per transaction; triggers write status history and the append-only audit log.

API reference, architecture, data model, normalisation, sequence diagrams, AI design and WBS: see the technical documentation.
