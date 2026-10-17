-- Money management: cash / bank / UPI accounts and one ledger for every receipt, payment, transfer and cheque.
-- Distributor payments move from "SupplierPayment" into the ledger unchanged in amount and date.

CREATE TYPE "PaymentMode" AS ENUM ('CASH', 'UPI', 'BANK', 'CHEQUE');
CREATE TYPE "MoneyAccountType" AS ENUM ('CASH', 'BANK', 'UPI');
CREATE TYPE "MoneyTxnKind" AS ENUM ('RECEIPT', 'PAYMENT', 'TRANSFER');
CREATE TYPE "MoneyPartyType" AS ENUM ('DISTRIBUTOR', 'TEXTILE', 'OTHER');
CREATE TYPE "ChequeStatus" AS ENUM ('PENDING', 'DEPOSITED', 'CLEARED', 'BOUNCED');

CREATE TABLE "MoneyAccount" (
    "id" TEXT NOT NULL,
    "type" "MoneyAccountType" NOT NULL,
    "name" TEXT NOT NULL,
    "bankName" TEXT,
    "branch" TEXT,
    "ifsc" TEXT,
    "accountHolder" TEXT,
    "accountNoEnc" TEXT,
    "accountNoLast4" TEXT,
    "upiId" TEXT,
    "openingBalance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MoneyAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MoneyTransaction" (
    "id" TEXT NOT NULL,
    "txnNo" TEXT NOT NULL,
    "kind" "MoneyTxnKind" NOT NULL,
    "txnDate" TIMESTAMP(3) NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "accountId" TEXT,
    "toAccountId" TEXT,
    "partyType" "MoneyPartyType",
    "supplierId" TEXT,
    "partyName" TEXT,
    "saleId" TEXT,
    "referenceNo" TEXT,
    "chequeNo" TEXT,
    "chequeDate" TIMESTAMP(3),
    "chequeBank" TEXT,
    "chequeStatus" "ChequeStatus",
    "depositedAt" TIMESTAMP(3),
    "clearedAt" TIMESTAMP(3),
    "bouncedAt" TIMESTAMP(3),
    "bounceReason" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MoneyTransaction_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MoneyTransaction_amount_positive" CHECK ("amount" > 0)
);

ALTER TABLE "Expense" ADD COLUMN "accountId" TEXT;
ALTER TABLE "Expense" ADD COLUMN "cancelledAt" TIMESTAMP(3);
ALTER TABLE "Expense" ADD COLUMN "cancelledById" TEXT;
ALTER TABLE "Expense" ADD COLUMN "cancelReason" TEXT;

CREATE INDEX "MoneyAccount_active_type_idx" ON "MoneyAccount"("active", "type");
CREATE UNIQUE INDEX "MoneyTransaction_txnNo_key" ON "MoneyTransaction"("txnNo");
CREATE INDEX "MoneyTransaction_kind_txnDate_idx" ON "MoneyTransaction"("kind", "txnDate");
CREATE INDEX "MoneyTransaction_accountId_txnDate_idx" ON "MoneyTransaction"("accountId", "txnDate");
CREATE INDEX "MoneyTransaction_toAccountId_idx" ON "MoneyTransaction"("toAccountId");
CREATE INDEX "MoneyTransaction_supplierId_kind_idx" ON "MoneyTransaction"("supplierId", "kind");
CREATE INDEX "MoneyTransaction_partyType_partyName_idx" ON "MoneyTransaction"("partyType", "partyName");
CREATE INDEX "MoneyTransaction_saleId_idx" ON "MoneyTransaction"("saleId");
CREATE INDEX "MoneyTransaction_mode_chequeStatus_idx" ON "MoneyTransaction"("mode", "chequeStatus");
CREATE INDEX "Expense_accountId_idx" ON "Expense"("accountId");

ALTER TABLE "MoneyTransaction" ADD CONSTRAINT "MoneyTransaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MoneyAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MoneyTransaction" ADD CONSTRAINT "MoneyTransaction_toAccountId_fkey" FOREIGN KEY ("toAccountId") REFERENCES "MoneyAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MoneyTransaction" ADD CONSTRAINT "MoneyTransaction_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MoneyTransaction" ADD CONSTRAINT "MoneyTransaction_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MoneyAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Old distributor payments become PAY-<year>-NNNNNN ledger entries. They had no account; a cheque among them was
-- already counted as paid, so it is recorded as cleared on its payment date. NEFT / RTGS / card keep their name in notes.
INSERT INTO "MoneyTransaction" (
    "id", "txnNo", "kind", "txnDate", "mode", "amount", "partyType", "supplierId", "partyName",
    "referenceNo", "chequeNo", "chequeStatus", "clearedAt", "notes", "createdAt", "updatedAt"
)
SELECT
    p."id",
    'PAY-' || EXTRACT(YEAR FROM p."paidAt")::int || '-' ||
        LPAD((ROW_NUMBER() OVER (PARTITION BY EXTRACT(YEAR FROM p."paidAt") ORDER BY p."paidAt", p."id"))::text, 6, '0'),
    'PAYMENT',
    p."paidAt",
    (CASE UPPER(TRIM(p."mode")) WHEN 'CASH' THEN 'CASH' WHEN 'UPI' THEN 'UPI' WHEN 'CHEQUE' THEN 'CHEQUE' ELSE 'BANK' END)::"PaymentMode",
    p."amount",
    'DISTRIBUTOR',
    p."supplierId",
    s."name",
    CASE WHEN UPPER(TRIM(p."mode")) = 'CHEQUE' THEN NULL ELSE p."referenceNo" END,
    CASE WHEN UPPER(TRIM(p."mode")) = 'CHEQUE' THEN p."referenceNo" ELSE NULL END,
    CASE WHEN UPPER(TRIM(p."mode")) = 'CHEQUE' THEN 'CLEARED'::"ChequeStatus" ELSE NULL END,
    CASE WHEN UPPER(TRIM(p."mode")) = 'CHEQUE' THEN p."paidAt" ELSE NULL END,
    CASE WHEN UPPER(TRIM(p."mode")) IN ('CASH', 'UPI', 'CHEQUE', 'BANK') THEN NULL ELSE 'Paid by ' || TRIM(p."mode") END,
    p."paidAt",
    CURRENT_TIMESTAMP
FROM "SupplierPayment" p
JOIN "Supplier" s ON s."id" = p."supplierId";

-- New payments continue after the copied ones.
INSERT INTO "DocumentSequence" ("key", "value", "updatedAt")
SELECT 'PAY-' || EXTRACT(YEAR FROM "paidAt")::int, COUNT(*), CURRENT_TIMESTAMP
FROM "SupplierPayment"
GROUP BY EXTRACT(YEAR FROM "paidAt")
ON CONFLICT ("key") DO UPDATE SET "value" = GREATEST("DocumentSequence"."value", EXCLUDED."value"), "updatedAt" = CURRENT_TIMESTAMP;

ALTER TABLE "SupplierPayment" DROP CONSTRAINT "SupplierPayment_supplierId_fkey";
DROP TABLE "SupplierPayment";
