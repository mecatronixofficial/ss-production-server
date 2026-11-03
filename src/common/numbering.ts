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
  return formatDocumentNo(prefix, year, await nextSequence(db, `${prefix}-${year}`), digits);
}

/** Increments and returns a named counter (made at 1 the first time). */
async function nextSequence(db: DbClient, key: string) {
  const [row] = await db.$queryRaw<Array<{ value: number }>>`
    INSERT INTO "DocumentSequence" ("key", "value", "updatedAt")
    VALUES (${key}, 1, NOW())
    ON CONFLICT ("key") DO UPDATE SET "value" = "DocumentSequence"."value" + 1, "updatedAt" = NOW()
    RETURNING "value"`;
  return Number(row.value);
}

const two = (n: number) => String(n).padStart(2, '0');

/** `01SS26`: the year's yarn number (two digits, growing past 99: `100SS26`), SS and the year. */
export const formatYarnCode = (sequence: number, year: number) => `${two(sequence)}SS${String(year).slice(-2)}`;

/**
 * Yarn code, e.g. `01SS26`: given to yarn when it is received into a warehouse, written on the bags and followed
 * through every process. Restarts at 01 each year (the counter is the one older `SS-2026-001` codes used).
 */
export const batchCode = async (db: DbClient, date = new Date()) => formatYarnCode(await nextSequence(db, `SS-${date.getFullYear()}`), date.getFullYear());

/** A knitting batch of a yarn: `01SS26-KT01`, `-KT02`… (one yarn can be knitted in several batches). */
export const knittingCode = (yarnCode: string, n: number) => `${yarnCode}-KT${two(n)}`;

/** A dyeing lot of a knitting batch, one per colour: `01SS26-KT01-DY01`, `-DY02`… Compacting keeps this code. */
export const dyeingLotCode = (knittingBatch: string, n: number) => `${knittingBatch}-DY${two(n)}`;
