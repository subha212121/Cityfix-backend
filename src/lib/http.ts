import { z } from 'zod';
import type { Request } from 'express';
import { unauthorized, forbidden } from './errors.js';
import type { Actor, Role } from '../db/pool.js';

export const Page = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
});
export type Page = z.infer<typeof Page>;

export const pageClause = (p: Page) => ({ limit: p.page_size, offset: (p.page - 1) * p.page_size });

export const paged = <T>(rows: (T & { total_count?: number })[], p: Page) => ({
  data: rows.map(({ total_count, ...r }) => r),
  page: p.page,
  page_size: p.page_size,
  total: rows[0]?.total_count ?? 0,
});

export const IdParam = z.object({ id: z.coerce.number().int().positive() });
export const UuidParam = z.object({ id: z.uuid() });

/** Comma list or repeated query value → array. */
export const csv = <T extends z.ZodType>(item: T) =>
  z.preprocess((v) => (v === undefined ? undefined : Array.isArray(v) ? v : String(v).split(',')), z.array(item).optional());

export function actorOf(req: Request): Actor {
  if (!req.actor) throw unauthorized();
  return req.actor;
}

export function requireActorRole(req: Request, ...roles: Role[]): Actor {
  const a = actorOf(req);
  if (!roles.includes(a.role)) throw forbidden();
  return a;
}

export const isStaff = (a: Actor) => a.role === 'officer' || a.role === 'admin';
