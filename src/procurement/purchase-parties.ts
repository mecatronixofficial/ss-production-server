import { BadRequestException } from '@nestjs/common';
import { Mill, Prisma } from '@prisma/client';
import { lockKeys } from '../common/locks';

export function millSupplierData(mill: Mill) {
  return {
    name: mill.name,
    contactPerson: mill.contactPerson,
    mobile: mill.mobile,
    email: mill.email,
    gst: mill.gst,
    address: [mill.address, mill.city, mill.state].filter(Boolean).join(', ') || null,
    paymentTerms: mill.paymentTerms,
    active: mill.active,
  };
}

/** Keep the existing supplier ledger identity while displaying the mill's current details. */
export function purchaseParty<T extends { millId?: string | null; mill?: Mill | null }>(party: T) {
  const { mill, ...data } = party;
  return mill
    ? { ...data, ...millSupplierData(mill), code: mill.code, partyType: 'MILL' as const }
    : { ...data, partyType: party.millId ? ('MILL' as const) : ('DISTRIBUTOR' as const) };
}

/** One linked purchase account per mill keeps receipts and existing payable reports connected. */
export async function resolvePurchaseSupplier(tx: Prisma.TransactionClient, party: { supplierId?: string; millId?: string }) {
  if (!!party.supplierId === !!party.millId) throw new BadRequestException('Select exactly one distributor or mill');
  if (party.supplierId) {
    const supplier = await tx.supplier.findFirst({
      where: { id: party.supplierId, active: true, millId: null },
      include: { mill: true },
    });
    if (!supplier) throw new BadRequestException('Select an active distributor');
    return supplier;
  }
  await lockKeys(tx, `mill-purchase:${party.millId}`);
  const mill = await tx.mill.findFirst({ where: { id: party.millId, active: true } });
  if (!mill) throw new BadRequestException('Select an active mill');
  const data = millSupplierData(mill);
  return tx.supplier.upsert({
    where: { millId: mill.id },
    create: { ...data, code: mill.code, millId: mill.id },
    update: data,
    include: { mill: true },
  });
}
