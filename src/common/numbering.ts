import { Prisma, PrismaClient } from '@prisma/client';

type DbClient = PrismaClient | Prisma.TransactionClient;

export function formatDocumentNo(prefix: string, year: number, sequence: number, digits = 6) {
  return `${prefix}-${year}-${String(sequence).padStart(digits, '0')}`;
}

/** Standard distributor code: `DST-` and a zero-padded number, e.g. `DST-00042`. Unlike document numbers it never resets. */
export const distributorCode = (n: number) => `DST-${String(n).padStart(5, '0')}`;

/**
 * Returns the next gap-free document number for a prefix, e.g. `SO-2026-000042`.
 *
 * The counter row is incremented atomically with an upsert, so concurrent
 * requests never receive the same number. When called inside a transaction the
 * increment rolls back with it, so failed requests do not burn numbers.
 * Counters reset every calendar year.
 */
export async function documentNo(db: DbClient, prefix: string, date = new Date(), digits = 6) {
  const year = date.getFullYear();
  const key = `${prefix}-${year}`;
  const [row] = await db.$queryRaw<Array<{ value: number }>>`
    INSERT INTO "DocumentSequence" ("key", "value", "updatedAt")
    VALUES (${key}, 1, NOW())
    ON CONFLICT ("key") DO UPDATE SET "value" = "DocumentSequence"."value" + 1, "updatedAt" = NOW()
    RETURNING "value"`;
  return formatDocumentNo(prefix, year, Number(row.value), digits);
}

/**
 * Yarn batch code, e.g. `SS-2026-001`: written on the bags and followed through knitting, dyeing,
 * compacting and delivery. Restarts at 001 each year; past 999 it simply grows (`SS-2026-1000`).
 */
export const batchCode = (db: DbClient) => documentNo(db, 'SS', new Date(), 3);
