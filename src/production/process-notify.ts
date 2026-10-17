import { Prisma, PrismaClient, Role } from '@prisma/client';
import { ADMIN_ROLES, MACHINE_ROLES } from '../common/roles';
import { notifyRoles } from '../notifications/notify.util';

/** A loss above this in one process is pointed out (the same limit the forms warn at). */
const BIG_LOSS_KG = 100;

const kg = (value: number) => `${value.toLocaleString('en-IN', { maximumFractionDigits: 3 })} KG`;

/** "−1.5 KG (0.63%)", "+0.4 KG (0.17%)", "no weight change". */
export function weightChange(input: number, output: number) {
  const diff = output - input;
  if (Math.abs(diff) < 0.0005) return 'no weight change';
  const pct = input > 0 ? ` (${((Math.abs(diff) / input) * 100).toFixed(2)}%)` : '';
  return `${diff > 0 ? '+' : '−'}${kg(Math.abs(diff))}${pct}`;
}

export type ProcessDone = {
  process: 'Knitting' | 'Dyeing' | 'Compacting';
  /** The batch code the notification opens. */
  flowNo: string;
  /** What went in and came out, e.g. 240 KG yarn → 238.5 KG grey fabric. */
  input: number | null;
  output: number;
  outputLabel: string;
  /** e.g. ["12 bags", "Navy", "24 rolls"]. */
  details: Array<string | null | undefined | false>;
  /** Where the fabric went next, e.g. "sent to dyeing at Sri Dyers" / "ready to deliver". */
  next: string;
};

/**
 * Tells the office a production process has been completed, with what came out of it, the weight lost or gained,
 * and where the fabric went next. Knitting also goes to managers (they run the machines); dyeing and compacting to
 * admins. A loss above BIG_LOSS_KG is marked high priority.
 */
export async function notifyProcessDone(db: Prisma.TransactionClient | PrismaClient, done: ProcessDone) {
  const roles: Role[] = done.process === 'Knitting' ? MACHINE_ROLES : ADMIN_ROLES;
  const loss = done.input !== null ? done.input - done.output : 0;
  const bigLoss = loss > BIG_LOSS_KG + 0.0005;
  const details = done.details.filter((d): d is string => !!d);
  return notifyRoles(db, roles, {
    title: `${done.process} completed · ${done.flowNo}${bigLoss ? ' · check the loss' : ''}`,
    message: [
      `${kg(done.output)} ${done.outputLabel}${done.input !== null ? ` from ${kg(done.input)}, ${weightChange(done.input, done.output)}` : ''}`,
      ...details,
      done.next,
    ].join(' · '),
    type: 'JOB_COMPLETED',
    priority: bigLoss ? 'HIGH' : 'NORMAL',
    referenceType: 'ProductionBatch',
    referenceId: done.flowNo,
  });
}
