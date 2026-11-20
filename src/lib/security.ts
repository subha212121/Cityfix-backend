import crypto from 'node:crypto';
import argon2 from 'argon2';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import type { Role } from '../db/pool.js';

// ---- Passwords: argon2id; bcrypt hashes (bootstrap admin) still verify and are upgraded on login
export const hashPassword = (plain: string) =>
  argon2.hash(plain, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });

export async function verifyPassword(hash: string | null, plain: string): Promise<boolean> {
  if (!hash) return false;
  if (hash.startsWith('$2')) return bcrypt.compare(plain, hash);
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

export const needsRehash = (hash: string) => hash.startsWith('$2');

/** At least 8 characters with a letter and a number. */
export const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).{8,128}$/;

// ---- Opaque tokens (refresh, email verification, reset, invitations): only the SHA-256 is stored
export function newOpaqueToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}
export const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest();

// ---- Access tokens (JWT, short-lived)
export interface AccessClaims {
  sub: string;
  role: Role;
}
export const signAccessToken = (claims: AccessClaims) =>
  jwt.sign(claims, config.JWT_SECRET, {
    expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
    issuer: 'cityfix-api',
    audience: 'cityfix-clients',
  });

export function verifyAccessToken(token: string): AccessClaims {
  const payload = jwt.verify(token, config.JWT_SECRET, {
    issuer: 'cityfix-api',
    audience: 'cityfix-clients',
  }) as jwt.JwtPayload;
  return { sub: String(payload.sub), role: payload.role as Role };
}
