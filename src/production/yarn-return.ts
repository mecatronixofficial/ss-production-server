import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InventoryService } from '../inventory/inventory.service';

type Flow = { id: string; flowNo: string; yarnIssueTxnId: string | null; yarnReturnTxnId: string | null };

/**
 * Puts the yarn knitting did not use back where it came from (same code, lot and warehouse), so the warehouse shows
 * the balance again: 200 KG given and 50 used puts 150 back. A correction replaces the earlier return, which is
 * refused once that yarn has been issued again. A leftover of 0 only takes back an earlier return. Used when
 * knitting finishes on the Production page and when an own-mill task is completed on the Machines page.
 */
export async function returnUnusedYarn(tx: Prisma.TransactionClient, inventory: InventoryService, flow: Flow, leftoverKg: number, actorId?: string | null) {
  if (flow.yarnReturnTxnId) {
    await inventory.removeInWithin(tx, flow.yarnReturnTxnId, actorId ?? null);
    await tx.fabricProductionFlow.update({ where: { id: flow.id }, data: { yarnReturnTxnId: null } });
  }
  if (leftoverKg <= 0.0005 || !flow.yarnIssueTxnId) return null;
  const issue = await tx.stockTransaction.findUniqueOrThrow({ where: { id: flow.yarnIssueTxnId } });
  const txn = await inventory.createTxn(
    {
      category: issue.category,
      txnType: 'KNITTING_RETURN',
      itemCode: issue.itemCode,
      itemName: issue.itemName,
      lotNo: issue.lotNo ?? undefined,
      warehouseId: issue.warehouseId,
      quantityIn: Math.round(leftoverKg * 1000) / 1000,
      unit: issue.unit,
      referenceType: 'PRODUCTION_BATCH',
      referenceId: flow.id,
      createdById: actorId ?? undefined,
      notes: `${flow.flowNo} yarn not used in knitting`,
    },
    tx,
  );
  await tx.fabricProductionFlow.update({ where: { id: flow.id }, data: { yarnReturnTxnId: txn.id } });
  return txn;
}

/** What settling a batch's yarn needs to know of it and of the batches sharing its yarn. */
export const poolSelect = {
  id: true,
  flowNo: true,
  yarnIssueTxnId: true,
  yarnReturnTxnId: true,
  yarnReceivedKg: true,
  purchasedWeightKg: true,
  knittingFinishedAt: true,
} satisfies Prisma.FabricProductionFlowSelect;
export type PoolFlow = Prisma.FabricProductionFlowGetPayload<{ select: typeof poolSelect }>;

const givenOf = (f: PoolFlow) => Number(f.yarnReceivedKg ?? f.purchasedWeightKg);

/**
 * A batch's place in the yarn it shares with the fabric types started with it (one yarn issue for all): the yarn
 * shared, the other batches, what the finished ones used, and what is left for this one. Null when it shares none.
 */
export function poolFigures(self: PoolFlow, group: PoolFlow[]) {
  const others = group.filter((g) => g.id !== self.id);
  if (!others.length) return null;
  const totalKg = group.reduce((sum, g) => sum + givenOf(g), 0);
  const finished = others.filter((g) => g.knittingFinishedAt);
  const usedByOthersKg = finished.reduce((sum, g) => sum + Number(g.purchasedWeightKg), 0);
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return {
    totalKg: round(totalKg),
    sharedWith: others.map((g) => g.flowNo),
    usedByOthersKg: round(usedByOthersKg),
    /** Batches sharing the yarn still knitting: what none uses goes back once they are all finished. */
    othersOpen: others.length - finished.length,
    leftForThisKg: round(Math.max(0, totalKg - usedByOthersKg)),
  };
}

/**
 * Records the yarn a batch used when its knitting finishes (or, with `usedKg` null, takes that back when it is opened
 * again) and puts the yarn not used back in the warehouse. A batch with its own yarn returns its rest at once; fabric
 * types sharing one yarn take theirs from what the finished ones left, and the rest goes back when the last finishes.
 * Answers the yarn used to record (its share again when opened).
 */
export async function settleYarnUsed(tx: Prisma.TransactionClient, inventory: InventoryService, flow: PoolFlow, usedKg: number | null, actorId?: string | null) {
  const group = flow.yarnIssueTxnId ? await tx.fabricProductionFlow.findMany({ where: { yarnIssueTxnId: flow.yarnIssueTxnId }, select: poolSelect }) : [flow];
  const self = group.find((g) => g.id === flow.id) ?? flow;
  const pool = poolFigures(self, group);
  if (!pool) {
    const given = givenOf(self);
    if (usedKg === null) {
      await returnUnusedYarn(tx, inventory, self, 0, actorId);
      return given;
    }
    if (usedKg > given + 0.0005) throw new BadRequestException(`Only ${given.toFixed(3)} KG of yarn was given to ${self.flowNo}`);
    await returnUnusedYarn(tx, inventory, self, given - usedKg, actorId);
    return usedKg;
  }
  // The shared yarn's return is worked out again from all of them, so any earlier one is taken back first.
  for (const g of group) if (g.yarnReturnTxnId) await returnUnusedYarn(tx, inventory, g, 0, actorId);
  if (usedKg === null) return givenOf(self);
  if (usedKg > pool.leftForThisKg + 0.0005) {
    throw new BadRequestException(`Only ${pool.leftForThisKg.toFixed(3)} KG of the yarn shared with ${pool.sharedWith.join(', ')} is left for ${self.flowNo}`);
  }
  if (pool.othersOpen === 0) await returnUnusedYarn(tx, inventory, { ...self, yarnReturnTxnId: null }, pool.leftForThisKg - usedKg, actorId);
  return usedKg;
}
