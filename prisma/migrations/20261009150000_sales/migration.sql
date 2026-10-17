-- Sales to distributors or textiles, dispatched from a warehouse after its staff verify them.
CREATE TYPE "SalePartyType" AS ENUM ('DISTRIBUTOR', 'TEXTILE');
CREATE TYPE "SaleStatus" AS ENUM ('PENDING', 'REJECTED', 'DISPATCHED', 'CANCELLED');

CREATE TABLE "Sale" (
    "id" TEXT NOT NULL,
    "saleNo" TEXT NOT NULL,
    "saleDate" TIMESTAMP(3) NOT NULL,
    "status" "SaleStatus" NOT NULL DEFAULT 'PENDING',
    "partyType" "SalePartyType" NOT NULL,
    "supplierId" TEXT,
    "partyName" TEXT NOT NULL,
    "partyGst" TEXT,
    "partyPhone" TEXT,
    "partyAddress" TEXT,
    "warehouseId" TEXT NOT NULL,
    "vehicleNo" TEXT,
    "driverName" TEXT,
    "driverPhone" TEXT,
    "transporter" TEXT,
    "lrNo" TEXT,
    "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 5,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "gstAmount" DECIMAL(14,2) NOT NULL,
    "totalAmount" DECIMAL(14,2) NOT NULL,
    "notes" TEXT,
    "createdById" TEXT,
    "verifiedById" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "dispatchNotes" TEXT,
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Sale_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SaleItem" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "category" "StockCategory" NOT NULL,
    "itemCode" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "lotNo" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'KG',
    "quantity" DECIMAL(14,3) NOT NULL,
    "dispatchedQty" DECIMAL(14,3),
    "rate" DECIMAL(14,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "stockTxnId" TEXT,
    CONSTRAINT "SaleItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Sale_saleNo_key" ON "Sale"("saleNo");
CREATE INDEX "Sale_status_warehouseId_idx" ON "Sale"("status", "warehouseId");
CREATE INDEX "Sale_saleDate_idx" ON "Sale"("saleDate");
CREATE INDEX "Sale_supplierId_idx" ON "Sale"("supplierId");
CREATE INDEX "SaleItem_saleId_idx" ON "SaleItem"("saleId");
CREATE INDEX "SaleItem_itemCode_idx" ON "SaleItem"("itemCode");

ALTER TABLE "Sale" ADD CONSTRAINT "Sale_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;
