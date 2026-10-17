import { Prisma } from '@prisma/client';

/**
 * Takes PostgreSQL transaction-scoped advisory locks for the given keys.
 *
 * Balance checks ("is there enough stock?", "is this invoice still open?")
 * followed by a write are not safe under READ COMMITTED: two concurrent
 * requests can both pass the check. Locking the logical key serialises those
 * requests; the lock is released automatically on commit or rollback.
 * Keys are sorted so that multi-key callers cannot deadlock each other.
 */
export async function lockKeys(tx: Prisma.TransactionClient, ...keys: string[]) {
  for (const key of Array.from(new Set(keys)).sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }
}
