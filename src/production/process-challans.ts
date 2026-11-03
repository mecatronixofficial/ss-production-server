import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { documentNo } from '../common/numbering';
import { itemSpecs } from '../common/item-specs';
import { PrismaService } from '../prisma/prisma.service';
import { pdfDate, pdfQuantity, renderChallanPdf } from '../common/challan-document-pdf';

/** What a challan says moved, from where to where. */
export type HandOff = {
  flowId: string;
  /** KNITTING, DYEING_IN, DYEING, COMPACTING_IN or DELIVERY:<delivery id>. */
  handOff: string;
  date: Date;
  material: 'Grey fabric' | 'Dyed fabric' | 'Finished fabric';
  from: { kind: 'PROCESS' | 'WAREHOUSE'; name: string };
  to: { kind: 'PROCESS' | 'WAREHOUSE' | 'PARTY'; name: string };
  weightKg: number;
  packages?: number | null;
  packageUnit?: 'bags' | 'rolls' | null;
  notes?: string | null;
  createdById?: string | null;
};

/**
 * Issues the delivery challan for a hand-off, in the caller's transaction, or brings an existing one up to date (a
 * corrected process keeps its challan number; one cancelled earlier is issued again under its number).
 */
export async function issueChallan(tx: Prisma.TransactionClient, h: HandOff) {
  const data = {
    date: h.date,
    material: h.material,
    fromKind: h.from.kind,
    fromName: h.from.name,
    toKind: h.to.kind,
    toName: h.to.name,
    weightKg: h.weightKg,
    packages: h.packages ?? null,
    packageUnit: h.packages ? (h.packageUnit ?? null) : null,
    cancelledAt: null,
    cancelReason: null,
  };
  const key = { flowId_handOff: { flowId: h.flowId, handOff: h.handOff } };
  const existing = await tx.processChallan.findUnique({ where: key, select: { id: true } });
  if (existing) return tx.processChallan.update({ where: key, data: { ...data, ...(h.notes !== undefined ? { notes: h.notes } : {}) } });
  return tx.processChallan.create({
    data: { ...data, flowId: h.flowId, handOff: h.handOff, challanNo: await documentNo(tx, 'PDC', h.date), notes: h.notes ?? null, createdById: h.createdById ?? null },
  });
}

/** Cancels a hand-off's challan (the delivery was undone); it stays on record. */
export async function cancelChallan(tx: Prisma.TransactionClient, flowId: string, handOff: string, reason: string) {
  await tx.processChallan.updateMany({ where: { flowId, handOff, cancelledAt: null }, data: { cancelledAt: new Date(), cancelReason: reason } });
}

/** Whether a hand-off already has a live challan (the fabric went straight on, so the next process needs no new one). */
export async function hasChallan(tx: Prisma.TransactionClient, flowId: string, handOff: string) {
  return !!(await tx.processChallan.findFirst({ where: { flowId, handOff, cancelledAt: null }, select: { id: true } }));
}

/** "WH-GREY · Grey fabric store" for the warehouse a stock issue took the fabric from. */
export async function issueWarehouseName(tx: Prisma.TransactionClient, txnId: string | null) {
  if (!txnId) return null;
  const txn = await tx.stockTransaction.findUnique({ where: { id: txnId }, select: { warehouse: { select: { code: true, name: true } } } });
  return txn ? `${txn.warehouse.code} · ${txn.warehouse.name}` : null;
}

const PROCESS_OF: Record<string, string> = {
  KNITTING: 'Knitting',
  DYEING_IN: 'Sent to dyeing',
  DYEING: 'Dyeing',
  COMPACTING_IN: 'Sent to compacting',
};
const processOf = (handOff: string) => PROCESS_OF[handOff] ?? 'Delivery';
const KIND_LABEL: Record<string, string> = { PROCESS: 'Mill', WAREHOUSE: 'Warehouse', PARTY: 'Party' };

const challanFlow = {
  select: {
    id: true,
    flowNo: true,
    yarnItemCode: true,
    yarnCount: true,
    fabricType: true,
    fabricDiameter: true,
    fabricGsm: true,
    knittingGg: true,
    knittingLl: true,
    color: true,
    dyeingCount: true,
  },
} satisfies Prisma.FabricProductionFlowDefaultArgs;

const view = <T extends { weightKg: Prisma.Decimal; handOff: string }>(c: T) => ({ ...c, weightKg: Number(c.weightKg), process: processOf(c.handOff) });

/** A challan party's details, as printed under its name: address, city, GSTIN and phone. */
export type PartyDetails = { address: string | null; city: string | null; gst: string | null; phone: string | null };
const blank = (v?: string | null) => v?.trim() || null;

/**
 * Who a challan is from / delivered to, in full, from the masters: a mill (Mill Details), a party (Textiles, then
 * Distributors, then Mills), a warehouse (its location), or the own mill (the company). Null when not found.
 */
async function detailsOf(prisma: PrismaService, kind: string, name: string, company: Record<string, string>): Promise<PartyDetails | null> {
  const label = name.trim();
  if (!label) return null;
  const like = { equals: label, mode: 'insensitive' as const };
  if (kind === 'WAREHOUSE') {
    const code = label.split(' · ')[0].trim();
    const warehouse = await prisma.warehouse.findFirst({ where: { OR: [{ code: { equals: code, mode: 'insensitive' } }, { name: like }] }, select: { location: true } });
    return warehouse ? { address: blank(warehouse.location), city: null, gst: blank(company.gst), phone: blank(company.phone) } : null;
  }
  if (kind === 'PROCESS' && /^own mill/i.test(label)) {
    return { address: blank(company.address), city: blank(company.city), gst: blank(company.gst), phone: blank(company.phone) };
  }
  if (kind === 'PARTY') {
    const textile = await prisma.textile.findFirst({ where: { name: like }, select: { address: true, city: true, gst: true, mobile: true } });
    if (textile) return { address: blank(textile.address), city: blank(textile.city), gst: blank(textile.gst), phone: blank(textile.mobile) };
    const supplier = await prisma.supplier.findFirst({ where: { name: like }, select: { address: true, gst: true, mobile: true } });
    if (supplier) return { address: blank(supplier.address), city: null, gst: blank(supplier.gst), phone: blank(supplier.mobile) };
  }
  const mill = await prisma.mill.findFirst({ where: { name: like }, select: { address: true, city: true, gst: true, mobile: true } });
  return mill ? { address: blank(mill.address), city: blank(mill.city), gst: blank(mill.gst), phone: blank(mill.mobile) } : null;
}

/** "Address, City" · "GSTIN 33ABC…" · "Ph 98…" lines for a challan party. */
const detailLines = (d: PartyDetails | null): string[] =>
  d ? [[d.address, d.city].filter(Boolean).join(', '), d.gst ? `GSTIN ${d.gst}` : '', d.phone ? `Ph ${d.phone}` : ''].filter(Boolean) : [];

/** Process delivery challans: the register, one challan to print or share, and its transport details. */
@Injectable()
export class ProcessChallansService {
  constructor(private prisma: PrismaService) {}

  async list(filter: { flowId?: string; from?: Date; to?: Date }) {
    const rows = await this.prisma.processChallan.findMany({
      where: {
        ...(filter.flowId ? { flowId: filter.flowId } : {}),
        ...(filter.from || filter.to ? { date: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } } : {}),
      },
      include: { flow: challanFlow },
      orderBy: [{ date: 'desc' }, { challanNo: 'desc' }],
      take: 2000,
    });
    return rows.map(view);
  }

  /** One challan ready to print: letterhead, from / to, the batch's fabric and its full details, weight and packages. */
  async document(id: string) {
    const challan = await this.prisma.processChallan.findUnique({ where: { id }, include: { flow: challanFlow } });
    if (!challan) throw new NotFoundException('Challan not found');
    const [company, specs, issuer] = await Promise.all([
      this.prisma.systemSetting.findUnique({ where: { key: 'company' } }),
      itemSpecs(this.prisma, [challan.flow.flowNo]),
      challan.createdById ? this.prisma.user.findUnique({ where: { id: challan.createdById }, select: { name: true } }) : null,
    ]);
    const companyInfo = (company?.value ?? {}) as Record<string, string>;
    // Who it is from and delivered to, in full (address, GSTIN, phone), from the masters.
    const [fromDetails, toDetails] = await Promise.all([
      detailsOf(this.prisma, challan.fromKind, challan.fromName, companyInfo),
      detailsOf(this.prisma, challan.toKind, challan.toName, companyInfo),
    ]);
    return {
      ...view(challan),
      fromDetails,
      toDetails,
      specs: specs.get(challan.flow.flowNo) ?? [],
      issuedBy: issuer?.name ?? null,
      company: companyInfo,
    };
  }

  /** Transport details and remarks, typed when the vehicle leaves. */
  async update(id: string, data: { vehicleNo?: string; driverName?: string; notes?: string }) {
    const challan = await this.prisma.processChallan.findUnique({ where: { id }, select: { cancelledAt: true, challanNo: true } });
    if (!challan) throw new NotFoundException('Challan not found');
    if (challan.cancelledAt) throw new BadRequestException(`${challan.challanNo} is cancelled`);
    await this.prisma.processChallan.update({
      where: { id },
      data: {
        ...(data.vehicleNo !== undefined ? { vehicleNo: data.vehicleNo.trim().toUpperCase() || null } : {}),
        ...(data.driverName !== undefined ? { driverName: data.driverName.trim() || null } : {}),
        ...(data.notes !== undefined ? { notes: data.notes.trim() || null } : {}),
      },
    });
    return this.document(id);
  }

  async pdf(id: string) {
    const c = await this.document(id);
    const timezone = c.company.timezone || 'Asia/Kolkata';
    const spec = c.specs.filter((s) => s.label !== 'Batch').map((s) => `${s.label} ${s.value}`).join(' · ');
    const buffer = await renderChallanPdf({
      title: 'Delivery Challan',
      number: c.challanNo,
      date: c.date,
      company: c.company,
      cancelled: !!c.cancelledAt,
      blocks: [
        { label: `From · ${KIND_LABEL[c.fromKind] ?? c.fromKind}`, lines: [[c.fromName, true], ...detailLines(c.fromDetails).map((line): [string] => [line])] },
        {
          label: `Deliver to · ${KIND_LABEL[c.toKind] ?? c.toKind}`,
          lines: [[c.toName, true], ...detailLines(c.toDetails).map((line): [string] => [line]), [`Vehicle ${c.vehicleNo || '—'}${c.driverName ? `  ·  Driver ${c.driverName}` : ''}`]],
        },
      ],
      references: [
        { label: 'Batch', value: c.flow.flowNo },
        { label: 'Process', value: c.process },
        { label: 'Date', value: pdfDate(c.date, timezone) },
      ],
      columns: [
        { label: '#', weight: 5 },
        { label: 'Fabric', weight: 45 },
        { label: 'Batch code', weight: 18 },
        { label: 'Packages', weight: 14, align: 'right' },
        { label: 'Weight', weight: 18, align: 'right' },
      ],
      rows: [
        {
          cells: ['1', c.material, c.flow.flowNo, c.packages ? `${c.packages} ${c.packageUnit ?? ''}`.trim() : '—', pdfQuantity(c.weightKg, 'KG')],
          sub: spec || [c.flow.fabricType, c.flow.color].filter(Boolean).join(' · '),
        },
      ],
      totals: [[`Total · ${c.material.toLowerCase()}`, pdfQuantity(c.weightKg, 'KG')]],
      notes: c.notes,
      issued: `${c.process} of batch ${c.flow.flowNo}.${c.issuedBy ? ` Issued by ${c.issuedBy}.` : ''} Computer-generated delivery challan; not a tax invoice.`,
      signatures: ['Sent by', `Driver${c.driverName ? ` (${c.driverName})` : ''}`, 'Received by'],
    });
    return { buffer, fileName: `${c.challanNo}.pdf` };
  }
}
