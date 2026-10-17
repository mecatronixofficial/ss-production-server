import { BadRequestException } from '@nestjs/common';
import { MoneyTxnKind, Prisma, PrismaClient, SaleStatus, Textile } from '@prisma/client';
import { lockKeys } from '../common/locks';
import { cleanName, nameKey, round2 } from '../finance/money-rules';

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Tx;

/** Standard textile code: `TXT-` and a zero-padded number, e.g. `TXT-00042`. Never reused. */
export const textileCode = (n: number) => `TXT-${String(n).padStart(5, '0')}`;

/** The code after the highest `TXT-<n>` in use (inactive textiles included). Call under the `textile:code` lock. */
export async function nextTextileCode(db: Db) {
  const [{ max }] = await db.$queryRaw<Array<{ max: number }>>`
    SELECT COALESCE(MAX(CAST(SUBSTRING("code" FROM 5) AS INTEGER)), 0) AS "max"
    FROM "Textile" WHERE "code" ~* '^TXT-[0-9]{1,9}$'`;
  return textileCode(Number(max) + 1);
}

/** Lock that serialises textile creation, so two saves never get the same code or name. */
export const lockTextiles = (tx: Tx, name: string) => lockKeys(tx, 'textile:code', `textile:${nameKey(name)}`);

type Details = { gst?: string | null; phone?: string | null; address?: string | null };

/** Fills details the textile doesn't have yet from what was typed on a sale (never overwrites). */
async function fillBlanks(db: Db, textile: Textile, d: Details) {
  const data: Prisma.TextileUpdateInput = {};
  const gst = d.gst?.trim().toUpperCase();
  if (!textile.gst && gst) data.gst = gst;
  if (!textile.mobile && d.phone?.trim()) data.mobile = d.phone.trim();
  if (!textile.address && d.address?.trim()) data.address = d.address.trim();
  return Object.keys(data).length ? db.textile.update({ where: { id: textile.id }, data }) : textile;
}

/**
 * The textile a sale or money entry is for: by id from the Textiles list, or by name. A name not on the list yet is
 * added to it (with the details typed), so every textile has one record however its name is typed.
 */
export async function resolveTextile(
  prisma: PrismaClient,
  input: { textileId?: string | null; name?: string | null } & Details,
  { requireActive = false }: { requireActive?: boolean } = {},
) {
  const check = (t: Textile) => {
    if (requireActive && !t.active)
      throw new BadRequestException(`${t.name} (${t.code}) is inactive; make it active on the Textiles list first`);
    return t;
  };
  if (input.textileId) {
    const textile = await prisma.textile.findUnique({ where: { id: input.textileId } });
    if (!textile) throw new BadRequestException('Textile not found');
    return fillBlanks(prisma, check(textile), input);
  }
  const name = cleanName(input.name ?? '');
  if (!name) throw new BadRequestException('Choose the textile or enter its name');
  return prisma.$transaction(async (tx) => {
    await lockTextiles(tx, name);
    const found = await tx.textile.findUnique({ where: { nameKey: nameKey(name) } });
    if (found) return fillBlanks(tx, check(found), input);
    return tx.textile.create({
      data: {
        code: await nextTextileCode(tx),
        name,
        nameKey: nameKey(name),
        gst: input.gst?.trim().toUpperCase() || null,
        mobile: input.phone?.trim() || null,
        address: input.address?.trim() || null,
      },
    });
  });
}

export type TextileMoney = {
  billed: number;
  bills: number;
  lastSaleAt: Date | null;
  received: number;
  receiveChequesPending: number;
  refunded: number;
  lastPaidAt: Date | null;
};

/**
 * Money with each textile: dispatched bills, money received (cheques once cleared; pending ones apart) and refunds
 * paid back. Balance = opening + billed − received + refunded (minus is an advance they paid).
 */
export async function textileMoney(db: Db, textileId?: string) {
  const [sales, money] = await Promise.all([
    db.sale.groupBy({
      by: ['textileId'],
      where: { status: SaleStatus.DISPATCHED, textileId: textileId ?? { not: null } },
      _sum: { totalAmount: true },
      _count: { _all: true },
      _max: { saleDate: true },
    }),
    db.$queryRaw<Array<{ textileId: string; kind: MoneyTxnKind; counted: number; pending: number; last: Date | null }>>`
      SELECT "textileId", "kind",
        COALESCE(SUM(CASE WHEN "mode" <> 'CHEQUE' OR "chequeStatus" = 'CLEARED' THEN "amount" ELSE 0 END), 0)::float8 AS "counted",
        COALESCE(SUM(CASE WHEN "mode" = 'CHEQUE' AND "chequeStatus" IN ('PENDING', 'DEPOSITED') THEN "amount" ELSE 0 END), 0)::float8 AS "pending",
        MAX("txnDate") AS "last"
      FROM "MoneyTransaction"
      WHERE "cancelledAt" IS NULL AND "textileId" IS NOT NULL AND "kind" IN ('RECEIPT', 'PAYMENT')
        ${textileId ? Prisma.sql`AND "textileId" = ${textileId}` : Prisma.empty}
      GROUP BY "textileId", "kind"`,
  ]);
  const result = new Map<string, TextileMoney>();
  const entry = (id: string) => {
    let row = result.get(id);
    if (!row) {
      row = { billed: 0, bills: 0, lastSaleAt: null, received: 0, receiveChequesPending: 0, refunded: 0, lastPaidAt: null };
      result.set(id, row);
    }
    return row;
  };
  for (const s of sales) {
    const row = entry(s.textileId!);
    row.billed = round2(Number(s._sum.totalAmount ?? 0));
    row.bills = s._count._all;
    row.lastSaleAt = s._max.saleDate;
  }
  for (const m of money) {
    const row = entry(m.textileId);
    if (m.kind === MoneyTxnKind.RECEIPT) {
      row.received = round2(Number(m.counted));
      row.receiveChequesPending = round2(Number(m.pending));
      row.lastPaidAt = m.last;
    } else {
      row.refunded = round2(Number(m.counted));
    }
  }
  return result;
}

/** What a textile owes now (minus: advance), from its opening balance and its money. */
export const textileBalance = (opening: number, m?: TextileMoney) =>
  round2(opening + (m?.billed ?? 0) - (m?.received ?? 0) + (m?.refunded ?? 0));
