-- Received / export bills for warehouse stock movements, issued by admins.
CREATE TYPE "StockBillKind" AS ENUM ('RECEIVED', 'EXPORT');

CREATE TABLE "StockBill" (
    "id" TEXT NOT NULL,
    "billNo" TEXT NOT NULL,
    "kind" "StockBillKind" NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "referenceType" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "partyName" TEXT,
    "vehicleNo" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockBill_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StockBill_billNo_key" ON "StockBill"("billNo");
CREATE INDEX "StockBill_warehouseId_createdAt_idx" ON "StockBill"("warehouseId", "createdAt");
CREATE INDEX "StockBill_referenceType_referenceId_idx" ON "StockBill"("referenceType", "referenceId");
ALTER TABLE "StockBill" ADD CONSTRAINT "StockBill_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StockTransaction" ADD COLUMN "stockBillId" TEXT;
CREATE INDEX "StockTransaction_stockBillId_idx" ON "StockTransaction"("stockBillId");
ALTER TABLE "StockTransaction" ADD CONSTRAINT "StockTransaction_stockBillId_fkey" FOREIGN KEY ("stockBillId") REFERENCES "StockBill"("id") ON DELETE SET NULL ON UPDATE CASCADE;
