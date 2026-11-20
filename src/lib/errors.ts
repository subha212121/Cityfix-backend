import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new AppError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'Sign in required') => new AppError(401, 'unauthorized', msg);
export const forbidden = (msg = 'You do not have permission to do this') => new AppError(403, 'forbidden', msg);
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (msg: string) => new AppError(409, 'conflict', msg);
export const unprocessable = (msg: string, details?: unknown) => new AppError(422, 'unprocessable', msg, details);

/** Turns Zod and PostgreSQL errors into API errors with the right HTTP status. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    return new AppError(
      400,
      'validation_error',
      'Some fields are missing or invalid',
      err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  }
  const pg = err as { code?: string; message?: string; constraint?: string; detail?: string };
  switch (pg?.code) {
    case '23505':
      return new AppError(409, 'duplicate', 'This already exists', { constraint: pg.constraint });
    case '23503':
      return new AppError(409, 'reference_error', 'A referenced record does not exist or is still in use', {
        constraint: pg.constraint,
      });
    case '23502':
      return new AppError(400, 'missing_field', pg.message ?? 'A required field is missing');
    case '23514':
      return new AppError(422, 'rule_violation', pg.message ?? 'A business rule blocked this change', {
        constraint: pg.constraint,
      });
    case '23000':
      return new AppError(409, 'integrity_error', pg.message ?? 'Data integrity rule failed');
    case '42501':
      return new AppError(403, 'forbidden', cleanPgMessage(pg.message) ?? 'Not allowed');
    case 'P0001':
      return new AppError(422, 'rule_violation', pg.message ?? 'A business rule blocked this change');
    case '22P02':
    case '22007':
    case '22008':
      return new AppError(400, 'invalid_value', 'A value has the wrong format');
    default:
      return new AppError(500, 'internal_error', 'Something went wrong');
  }
}

function cleanPgMessage(m?: string) {
  if (!m) return m;
  // RLS denials read badly; give a plain message instead
  if (m.includes('row-level security')) return 'You do not have permission to do this';
  return m;
}
