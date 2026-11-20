import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config, isProd, isTest } from '../../config.js';
import { one, withTx, type Db, type Role } from '../../db/pool.js';
import { AppError, badRequest, conflict, forbidden, unauthorized } from '../../lib/errors.js';
import { appLink, sendMailLater } from '../../lib/mailer.js';
import bcrypt from 'bcryptjs';
import {
  hashPassword, needsRehash, newOpaqueToken, PASSWORD_RULE, sha256, signAccessToken, verifyPassword,
} from '../../lib/security.js';

export const authRouter = Router();

// Compared against when the email is unknown, so both paths take the same time
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

// Brute-force protection on credential endpoints (off in tests)
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: isTest ? 10_000 : 20, standardHeaders: 'draft-8', legacyHeaders: false });

const Password = z.string().regex(PASSWORD_RULE, 'Use at least 8 characters with a letter and a number');
const Email = z.email().max(254).transform((e) => e.toLowerCase());

/** Dev/test only: return one-time tokens so the prototype and tests work without an inbox. */
const devToken = (token: string) => (isProd ? {} : { dev_token: token });

async function issueSession(db: Db, user: { id: string; role: Role }, req: { ip?: string; headers: Record<string, any> }) {
  const refresh = newOpaqueToken();
  await db.query(
    `INSERT INTO user_sessions (user_id, refresh_token_hash, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))`,
    [user.id, refresh.hash, String(req.headers['user-agent'] ?? '').slice(0, 300), req.ip ?? null, config.REFRESH_TOKEN_TTL_DAYS],
  );
  return {
    access_token: signAccessToken({ sub: user.id, role: user.role }),
    token_type: 'Bearer',
    expires_in: config.ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refresh.token,
  };
}

// POST /auth/register — citizen sign-up (S2). Staff join by invitation.
authRouter.post('/register', limiter, async (req, res) => {
  const body = z
    .object({
      email: Email,
      password: Password,
      full_name: z.string().trim().min(2).max(120),
      phone: z.string().trim().max(30).optional(),
      home_suburb: z.string().trim().max(80).optional(),
      accept_terms: z.literal(true, { message: 'You must accept the terms of use' }),
    })
    .parse(req.body);

  const result = await withTx(null, async (db) => {
    const exists = await one(db, 'SELECT 1 FROM users WHERE email = $1', [body.email]);
    if (exists) throw conflict('An account with this email already exists');
    const user = await one<{ id: string }>(
      db,
      `INSERT INTO users (email, password_hash, full_name, phone, role, status)
       VALUES ($1, $2, $3, $4, 'citizen', 'pending') RETURNING id`,
      [body.email, await hashPassword(body.password), body.full_name, body.phone ?? null],
    );
    await db.query('INSERT INTO citizen_profiles (user_id, home_suburb) VALUES ($1, $2)', [user!.id, body.home_suburb ?? null]);
    const t = newOpaqueToken();
    await db.query(
      `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1, 'email_verification', $2, now() + interval '24 hours')`,
      [user!.id, t.hash],
    );
    return { id: user!.id, token: t.token };
  });

  sendMailLater(body.email, 'Confirm your CityFix account',
    `Hi ${body.full_name},\n\nConfirm your email to start reporting issues:\n${appLink(`/verify-email?token=${result.token}`)}\n\nThe link expires in 24 hours.`);
  res.status(201).json({ id: result.id, email: body.email, status: 'pending', ...devToken(result.token) });
});

// POST /auth/verify-email
authRouter.post('/verify-email', async (req, res) => {
  const { token } = z.object({ token: z.string().min(20) }).parse(req.body);
  await withTx(null, async (db) => {
    const row = await one<{ user_id: string }>(
      db,
      `UPDATE auth_tokens SET used_at = now()
        WHERE token_hash = $1 AND purpose = 'email_verification' AND used_at IS NULL AND expires_at > now()
        RETURNING user_id`,
      [sha256(token)],
    );
    if (!row) throw badRequest('This link is invalid or has expired');
    await db.query(`UPDATE users SET email_verified_at = now(), status = 'active' WHERE id = $1 AND status = 'pending'`, [row.user_id]);
  });
  res.json({ verified: true });
});

// POST /auth/login (S1) — role is checked on every later request (FR-02)
authRouter.post('/login', limiter, async (req, res) => {
  const body = z.object({ email: Email, password: z.string().min(1).max(200) }).parse(req.body);
  const out = await withTx(null, async (db) => {
    const u = await one<{ id: string; role: Role; status: string; password_hash: string | null; locked_until: Date | null; full_name: string }>(
      db,
      'SELECT id, role, status, password_hash, locked_until, full_name FROM users WHERE email = $1 AND deleted_at IS NULL FOR UPDATE',
      [body.email],
    );
    if (!u) {
      await verifyPassword(DUMMY_HASH, body.password);
      throw unauthorized('Email or password is incorrect');
    }
    if (u.locked_until && u.locked_until > new Date()) throw new AppError(423, 'locked', 'Too many attempts. Try again in 15 minutes.');
    if (!(await verifyPassword(u.password_hash, body.password))) {
      await db.query(
        `UPDATE users SET failed_login_count = failed_login_count + 1,
                locked_until = CASE WHEN failed_login_count + 1 >= 5 THEN now() + interval '15 minutes' END
          WHERE id = $1`,
        [u.id],
      );
      return { failed: true as const };
    }
    if (u.status === 'pending') throw forbidden('Confirm your email address before signing in');
    if (u.status === 'inactive') throw forbidden('This account is deactivated');

    await db.query(
      `UPDATE users SET failed_login_count = 0, locked_until = NULL, last_active_at = now()${needsRehash(u.password_hash!) ? ', password_hash = $2' : ''} WHERE id = $1`,
      needsRehash(u.password_hash!) ? [u.id, await hashPassword(body.password)] : [u.id],
    );
    await db.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, ip_address, user_agent)
       VALUES ($1, 'signed_in', 'user', $4, $2, $3)`,
      [u.id, req.ip ?? null, String(req.headers['user-agent'] ?? '').slice(0, 300), u.id],
    );
    const tokens = await issueSession(db, u, req);
    return { ...tokens, user: { id: u.id, role: u.role, full_name: u.full_name } };
  });
  if ('failed' in out) throw unauthorized('Email or password is incorrect');
  res.json(out);
});

// POST /auth/refresh — rotates the refresh token
authRouter.post('/refresh', async (req, res) => {
  const { refresh_token } = z.object({ refresh_token: z.string().min(20) }).parse(req.body);
  const out = await withTx(null, async (db) => {
    const s = await one<{ id: string; user_id: string; role: Role; status: string }>(
      db,
      `UPDATE user_sessions s SET revoked_at = now()
         FROM users u
        WHERE s.refresh_token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.id = s.user_id
        RETURNING s.id, s.user_id, u.role, u.status`,
      [sha256(refresh_token)],
    );
    if (!s || s.status !== 'active') throw unauthorized('Session expired. Sign in again.');
    await db.query('UPDATE users SET last_active_at = now() WHERE id = $1', [s.user_id]);
    return issueSession(db, { id: s.user_id, role: s.role }, req);
  });
  res.json(out);
});

// POST /auth/logout
authRouter.post('/logout', async (req, res) => {
  const { refresh_token } = z.object({ refresh_token: z.string().min(20) }).parse(req.body);
  await withTx(null, (db) => db.query('UPDATE user_sessions SET revoked_at = now() WHERE refresh_token_hash = $1', [sha256(refresh_token)]));
  res.status(204).end();
});

// POST /auth/forgot-password (S3) — same answer whether or not the email exists
authRouter.post('/forgot-password', limiter, async (req, res) => {
  const { email } = z.object({ email: Email }).parse(req.body);
  const token = await withTx(null, async (db) => {
    const u = await one<{ id: string; full_name: string }>(db, `SELECT id, full_name FROM users WHERE email = $1 AND deleted_at IS NULL AND status <> 'inactive'`, [email]);
    if (!u) return null;
    const t = newOpaqueToken();
    await db.query(
      `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1, 'password_reset', $2, now() + interval '1 hour')`,
      [u.id, t.hash],
    );
    sendMailLater(email, 'Reset your CityFix password', `Hi ${u.full_name},\n\nReset your password here (valid for 1 hour):\n${appLink(`/reset-password?token=${t.token}`)}\n\nIf you did not ask for this, ignore this email.`);
    return t.token;
  });
  res.status(202).json({ message: 'If that email has an account, a reset link is on its way.', ...(token ? devToken(token) : {}) });
});

// POST /auth/reset-password
authRouter.post('/reset-password', limiter, async (req, res) => {
  const body = z.object({ token: z.string().min(20), password: Password }).parse(req.body);
  await withTx(null, async (db) => {
    const row = await one<{ user_id: string }>(
      db,
      `UPDATE auth_tokens SET used_at = now()
        WHERE token_hash = $1 AND purpose = 'password_reset' AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
      [sha256(body.token)],
    );
    if (!row) throw badRequest('This link is invalid or has expired');
    await db.query(
      `UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL,
              status = CASE WHEN status = 'pending' THEN 'active'::account_status ELSE status END,
              email_verified_at = coalesce(email_verified_at, now())
        WHERE id = $1`,
      [row.user_id, await hashPassword(body.password)],
    );
    await db.query('UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [row.user_id]);
    await db.query(`INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES ($1, 'password_reset', 'user', $2)`, [row.user_id, String(row.user_id)]);
  });
  res.json({ reset: true });
});

// POST /auth/accept-invite — invited officer/admin sets a password
authRouter.post('/accept-invite', limiter, async (req, res) => {
  const body = z.object({ token: z.string().min(20), full_name: z.string().trim().min(2).max(120), password: Password }).parse(req.body);
  const user = await withTx(null, async (db) => {
    const inv = await one<{ id: string; email: string; role: Role; employee_no: string; department_id: number | null; team_id: number | null }>(
      db,
      `SELECT id, email, role, employee_no, department_id, team_id FROM staff_invitations
        WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`,
      [sha256(body.token)],
    );
    if (!inv) throw badRequest('This invitation is invalid or has expired');
    const u = await one<{ id: string }>(
      db,
      `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at)
       VALUES ($1, $2, $3, $4, 'active', now()) RETURNING id`,
      [inv.email, await hashPassword(body.password), body.full_name, inv.role],
    );
    if (inv.role === 'officer') {
      await db.query('INSERT INTO officer_profiles (user_id, employee_no, department_id, team_id) VALUES ($1, $2, $3, $4)', [u!.id, inv.employee_no, inv.department_id, inv.team_id]);
    } else {
      await db.query('INSERT INTO admin_profiles (user_id, employee_no, department_id) VALUES ($1, $2, $3)', [u!.id, inv.employee_no, inv.department_id]);
    }
    await db.query('UPDATE staff_invitations SET accepted_at = now(), accepted_user_id = $2 WHERE id = $1', [inv.id, u!.id]);
    await db.query(`INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, after_data) VALUES ($1, 'invitation_accepted', 'user', $3, $2)`,
      [u!.id, JSON.stringify({ role: inv.role, department_id: inv.department_id }), u!.id]);
    return { id: u!.id, role: inv.role };
  });
  res.status(201).json(user);
});
