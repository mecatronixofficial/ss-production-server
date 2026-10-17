/**
 * Rewrites hand-typed distributor codes into the standard format (`dst-3`, `DST_003`, old `SUP-00003` → `DST-00003`).
 * A code is left alone when its standard form is already used by another distributor (deactivated ones
 * included), or when it isn't a DST / SUP number at all; those can be fixed from the Distributors page.
 * Each change is written to the audit log with the old code.
 *
 *   npm run fix:distributor-codes             # dry run: only prints what would change
 *   npm run fix:distributor-codes -- --apply  # makes the changes
 */
import { PrismaClient } from '@prisma/client';
import { distributorCode } from '../src/common/numbering';

const prisma = new PrismaClient();
const CODE_NUMBER = /^\s*(?:dst|sup)[\s_-]*0*(\d+)\s*$/i;

async function main() {
  const apply = process.argv.includes('--apply');
  const suppliers = await prisma.supplier.findMany({ select: { id: true, code: true, name: true }, orderBy: { createdAt: 'asc' } });
  // Every code in use, upper-cased, updated as changes are planned so two old codes can't claim the same new one.
  const taken = new Map(suppliers.map((s) => [s.code.toUpperCase(), s.id]));
  const changes: Array<{ id: string; name: string; from: string; to: string }> = [];
  const skipped: string[] = [];

  for (const s of suppliers) {
    const match = CODE_NUMBER.exec(s.code);
    if (!match) {
      skipped.push(`${s.code} (${s.name}): not a DST number`);
      continue;
    }
    const to = distributorCode(Number(match[1]));
    if (to === s.code) continue;
    const owner = taken.get(to);
    if (owner && owner !== s.id) {
      skipped.push(`${s.code} (${s.name}): ${to} is already used by ${suppliers.find((o) => o.id === owner)?.name}`);
      continue;
    }
    taken.delete(s.code.toUpperCase());
    taken.set(to, s.id);
    changes.push({ id: s.id, name: s.name, from: s.code, to });
  }

  for (const c of changes) console.log(`${apply ? 'Changing' : 'Would change'} ${c.from} → ${c.to} (${c.name})`);
  for (const line of skipped) console.log(`Skipped ${line}`);
  if (!changes.length) return console.log('No codes to change.');
  if (!apply) return console.log(`\n${changes.length} code(s) would change. Re-run with --apply to make the changes.`);

  await prisma.$transaction(
    changes.flatMap((c) => [
      prisma.supplier.update({ where: { id: c.id }, data: { code: c.to } }),
      prisma.auditLog.create({
        data: {
          action: 'SUPPLIER_CODE_CHANGED',
          module: 'masters',
          entity: 'Supplier',
          entityId: c.id,
          previousValue: { code: c.from },
          newValue: { code: c.to, reason: 'Standardised distributor code format' },
        },
      }),
    ]),
  );
  console.log(`\n${changes.length} code(s) changed.`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
