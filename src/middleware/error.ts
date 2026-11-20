import type { NextFunction, Request, Response } from 'express';
import { toAppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` } });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const e = toAppError(err);
  if (e.status >= 500) logger.error({ err, path: req.path }, 'unhandled error');
  res.status(e.status).json({ error: { code: e.code, message: e.message, details: e.details } });
}
