import { Prisma } from '../../generated/prisma/client.js';

// PostgreSQL SQLSTATE codes this codebase reacts to.
export const PgCode = {
  UNIQUE_VIOLATION: '23505',
  CHECK_VIOLATION: '23514',
  DEADLOCK_DETECTED: '40P01',
  SERIALIZATION_FAILURE: '40001',
} as const;

export interface PgErrorInfo {
  code: string;
  constraint?: string;
}

interface DriverAdapterCause {
  originalCode?: string;
  originalMessage?: string;
  constraint?: { index?: string; name?: string };
}

/**
 * Extracts the PostgreSQL error code (and constraint name, when there is one)
 * from a Prisma error. With driver adapters the original SQLSTATE is kept in
 * meta.driverAdapterError.cause, both for ORM calls (P2002) and raw SQL (P2010).
 */
export function pgError(error: unknown): PgErrorInfo | undefined {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return undefined;
  }
  const meta = error.meta as
    { driverAdapterError?: { cause?: DriverAdapterCause } } | undefined;
  const cause = meta?.driverAdapterError?.cause;
  if (!cause?.originalCode) {
    return undefined;
  }
  const constraint =
    cause.constraint?.index ??
    cause.constraint?.name ??
    cause.originalMessage?.match(/constraint "([^"]+)"/)?.[1];
  return { code: cause.originalCode, constraint };
}

export function isPgError(
  error: unknown,
  code: string,
  constraint?: string,
): boolean {
  const info = pgError(error);
  return (
    info?.code === code &&
    (constraint === undefined || info.constraint === constraint)
  );
}
