import type { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '../lib/security.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import type { Actor, Role } from '../db/pool.js';

declare global {
  namespace Express {
    interface Request {
      actor?: Actor;
    }
  }
}

/** Reads the Bearer token if present. Routes then decide whether sign-in is required. */
export function readToken(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const claims = verifyAccessToken(header.slice(7));
      req.actor = { userId: claims.sub, role: claims.role };
    } catch {
      return next(unauthorized('Your session has expired. Sign in again.'));
    }
  }
  next();
}

export const requireAuth = (req: Request, _res: Response, next: NextFunction) =>
  req.actor ? next() : next(unauthorized());

export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.actor) return next(unauthorized());
    if (!roles.includes(req.actor.role)) return next(forbidden());
    next();
  };

export const staffOnly = requireRole('officer', 'admin');
export const adminOnly = requireRole('admin');
export const citizenOnly = requireRole('citizen');
