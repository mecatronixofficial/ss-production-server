import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

// The seed wipes every table before inserting demo data. Refuse to run unless
// the operator explicitly opts in, so a stray `prisma db seed` or
// `prisma migrate reset` can never erase a real database.
function assertDestructiveSeedAllowed() {
  if (process.env.ALLOW_DESTRUCTIVE_SEED === 'true') return;
  console.error(
    [
      'Refusing to seed: this script DELETES ALL DATA before inserting demo records.',
      'Run with ALLOW_DESTRUCTIVE_SEED=true against a disposable database only.',
      'To create just an admin login on an existing database use: npm run create:superadmin',
    ].join('\n'),
  );
  process.exit(1);
}

/**
 * Demo data for the mill as it works today: warehouses, staff and logins, distributors (Supplier records), outside
 * mills, knitting machines, opening yarn stock, one open purchase order and a few expenses. Production batches,
 * machine runs and deliveries are then created from the app.
 */
async function main() {
  assertDestructiveSeedAllowed();

  // Children before parents.
  await prisma.knittingRunYarn.deleteMany();
  await prisma.knittingRun.deleteMany();
  await prisma.fabricFlowAttachment.deleteMany();
  await prisma.fabricFlowExpense.deleteMany();
  await prisma.fabricFlowDelivery.deleteMany();
  await prisma.fabricProductionFlow.deleteMany();
  await prisma.documentSequence.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.dyeRecipeItem.deleteMany();
  await prisma.dyeRecipe.deleteMany();
  await prisma.chemical.deleteMany();
  await prisma.yarnStockLot.deleteMany();
  await prisma.stockTransaction.deleteMany();
  await prisma.purchaseReceiptItem.deleteMany();
  await prisma.purchaseReceipt.deleteMany();
  await prisma.purchaseOrderItem.deleteMany();
  await prisma.purchaseOrder.deleteMany();
  await prisma.moneyTransaction.deleteMany();
  await prisma.expense.deleteMany();
  await prisma.moneyAccount.deleteMany();
  await prisma.saleItem.deleteMany();
  await prisma.sale.deleteMany();
  await prisma.stockBill.deleteMany();
  await prisma.textile.deleteMany();
  await prisma.refreshSession.deleteMany();
  await prisma.user.deleteMany();
  await prisma.machine.deleteMany();
  await prisma.employee.deleteMany();
  await prisma.supplier.deleteMany();
  await prisma.mill.deleteMany();
  await prisma.warehouse.deleteMany();
  await prisma.systemSetting.deleteMany();

  // Grey and finished goods warehouses start empty; fabric arrives there from production.
  const [, yarnWh] = await Promise.all([
    prisma.warehouse.create({ data: { code: 'WH-RM', name: 'Raw Material Warehouse' } }),
    prisma.warehouse.create({ data: { code: 'WH-YARN', name: 'Yarn Warehouse' } }),
    prisma.warehouse.create({ data: { code: 'WH-GREY', name: 'Grey Fabric Warehouse' } }),
    prisma.warehouse.create({ data: { code: 'WH-FG', name: 'Finished Goods Warehouse' } }),
  ]);

  const managerEmp = await prisma.employee.create({ data: { code: 'EMP-001', name: 'Arun Manager', department: 'Production', shift: 'General' } });
  const operatorEmp = await prisma.employee.create({ data: { code: 'EMP-002', name: 'Kumar Operator', department: 'Knitting', shift: 'A' } });
  const godownEmp = await prisma.employee.create({ data: { code: 'EMP-003', name: 'Ravi Godown', department: 'Stores', shift: 'A' } });
  const passwordHash = await argon2.hash(process.env.DEMO_PASSWORD || 'Demo@12345');

  const admin = await prisma.user.create({ data: { name: 'Super Admin', email: 'admin@example.com', passwordHash, role: 'SUPERADMIN' } });
  await prisma.user.create({ data: { name: 'Arun Manager', email: 'manager@example.com', passwordHash, role: 'MANAGER', employeeId: managerEmp.id } });
  await prisma.user.create({ data: { name: 'Ravi Godown', email: 'worker@example.com', passwordHash, role: 'STAFF', employeeId: godownEmp.id } });

  // Distributors the mill buys yarn and material from (stored as Supplier records).
  const cotton = await prisma.supplier.create({
    data: { code: 'DST-00001', name: 'Cotton Source India', company: 'Cotton Source India', materialCategory: 'Yarn / Cotton', paymentTerms: '30 Days' },
  });
  await prisma.supplier.create({ data: { code: 'DST-00002', name: 'ColorChem', company: 'ColorChem Pvt Ltd', materialCategory: 'Dyes & Chemicals' } });

  await prisma.mill.createMany({
    data: [
      { code: 'PC-001', name: 'Sri Murugan Dyeing Mill', services: 'DYEING', city: 'Tiruppur', state: 'Tamil Nadu' },
      { code: 'PC-002', name: 'Kongu Compacting', services: 'COMPACTING', city: 'Tiruppur', state: 'Tamil Nadu' },
    ],
  });

  await prisma.machine.createMany({
    data: [
      { code: 'KN-01', name: 'Circular Knitting 01', department: 'Knitting', type: 'Single jersey 30" 24G', capacityKg: 240, ratePerKg: 12, status: 'IDLE', operatorId: operatorEmp.id },
      { code: 'KN-02', name: 'Circular Knitting 02', department: 'Knitting', type: 'Rib 34" 18G', capacityKg: 240, ratePerKg: 14, status: 'IDLE' },
      { code: 'KN-03', name: 'Circular Knitting 03', department: 'Knitting', capacityKg: 300, ratePerKg: 12, status: 'IDLE' },
    ],
  });

  // Opening yarn stock, so a batch can be started from the Production page straight away.
  await prisma.stockTransaction.createMany({
    data: [
      { category: 'YARN', txnType: 'OPENING', itemCode: 'SS-2026-001', itemName: '30s Combed Cotton', lotNo: 'L-101', warehouseId: yarnWh.id, quantityIn: 1200, referenceType: 'OPENING', referenceId: 'OPEN-YARN-01', createdById: admin.id },
      { category: 'YARN', txnType: 'OPENING', itemCode: 'SS-2026-002', itemName: '40s Compact Cotton', lotNo: 'L-102', warehouseId: yarnWh.id, quantityIn: 800, referenceType: 'OPENING', referenceId: 'OPEN-YARN-02', createdById: admin.id },
    ],
  });

  // One purchase order on its way to the yarn warehouse, waiting to be received there.
  await prisma.purchaseOrder.create({
    data: {
      poNo: 'PUR-2026-000001',
      supplierId: cotton.id,
      warehouseId: yarnWh.id,
      expectedDate: new Date(Date.now() + 5 * 86_400_000),
      status: 'ORDERED',
      items: { create: [{ itemName: '30s Combed Cotton', category: 'YARN', quantity: 1000, unit: 'KG', rate: 265 }] },
    },
  });

  await prisma.expense.createMany({
    data: [
      { expenseNo: 'EXP-2026-000001', category: 'Power', description: 'Production power allocation', amount: 185000, paymentMode: 'NEFT', branch: 'Main Factory' },
      { expenseNo: 'EXP-2026-000002', category: 'Transport', description: 'Yarn freight', amount: 28000, paymentMode: 'NEFT', branch: 'Main Factory' },
    ],
  });

  await prisma.notification.create({
    data: { userId: admin.id, title: 'Demo ERP ready', message: 'Start a batch on the Production page from yarn SS-2026-001 in WH-YARN.', type: 'SYSTEM', priority: 'NORMAL' },
  });

  await prisma.systemSetting.createMany({
    data: [
      { key: 'company', value: { name: 'SS Clothing Mills', currency: 'INR', timezone: 'Asia/Kolkata', gst: '33ABCDE1234F1Z5' } },
      { key: 'tolerances', value: { yarnBalanceKg: 5, knittingWastePct: 3, dyeingLossPct: 4 } },
    ],
  });

  // Continue document numbering after the fixed demo numbers above.
  await prisma.$executeRaw`
    INSERT INTO "DocumentSequence" ("key", "value", "updatedAt")
    SELECT substring(no FROM '^([A-Z]+-[0-9]{4})-'), MAX(substring(no FROM '([0-9]{6})$')::INTEGER), NOW()
    FROM (SELECT "poNo" AS no FROM "PurchaseOrder" UNION ALL SELECT "expenseNo" FROM "Expense") AS documents
    WHERE no ~ '^[A-Z]+-[0-9]{4}-[0-9]{6}$'
    GROUP BY 1`;

  console.log('Seed complete');
  console.log('Demo password:', process.env.DEMO_PASSWORD || 'Demo@12345');
  console.log('Super Admin: admin@example.com');
  console.log('Manager (machines): manager@example.com');
  console.log('Staff (godown): worker@example.com');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
