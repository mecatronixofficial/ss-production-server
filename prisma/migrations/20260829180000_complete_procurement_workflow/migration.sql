-- Replace the free-text PO status with a controlled procurement lifecycle.
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');

ALTER TABLE "PurchaseOrder" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "PurchaseOrder"
ALTER COLUMN "status" TYPE "PurchaseOrderStatus"
USING (
  CASE
    WHEN "status" = 'RECEIVED' THEN 'RECEIVED'
    WHEN "status" = 'CANCELLED' THEN 'CANCELLED'
    ELSE 'ORDERED'
  END
)::"PurchaseOrderStatus";
ALTER TABLE "PurchaseOrder" ALTER COLUMN "status" SET DEFAULT 'ORDERED';

-- A goods receipt (GRN) preserves every partial receipt instead of overwriting PO state.
CREATE TABLE "PurchaseReceipt" (
  "id" TEXT NOT NULL,
  "receiptNo" TEXT NOT NULL,
  "purchaseOrderId" TEXT NOT NULL,
  "warehouseId" TEXT NOT NULL,
  "category" "StockCategory" NOT NULL,
  "lotNo" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "receivedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PurchaseReceipt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PurchaseReceiptItem" (
  "id" TEXT NOT NULL,
  "purchaseReceiptId" TEXT NOT NULL,
  "purchaseOrderItemId" TEXT NOT NULL,
  "quantity" DECIMAL(14,3) NOT NULL,
  CONSTRAINT "PurchaseReceiptItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PurchaseReceipt_receiptNo_key" ON "PurchaseReceipt"("receiptNo");
CREATE INDEX "PurchaseReceipt_purchaseOrderId_receivedAt_idx" ON "PurchaseReceipt"("purchaseOrderId", "receivedAt");
CREATE INDEX "PurchaseReceipt_warehouseId_category_idx" ON "PurchaseReceipt"("warehouseId", "category");
CREATE UNIQUE INDEX "PurchaseReceiptItem_purchaseReceiptId_purchaseOrderItemId_key" ON "PurchaseReceiptItem"("purchaseReceiptId", "purchaseOrderItemId");
CREATE INDEX "PurchaseReceiptItem_purchaseOrderItemId_idx" ON "PurchaseReceiptItem"("purchaseOrderItemId");
CREATE INDEX "PurchaseOrder_status_expectedDate_idx" ON "PurchaseOrder"("status", "expectedDate");

ALTER TABLE "PurchaseReceipt"
ADD CONSTRAINT "PurchaseReceipt_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseReceipt"
ADD CONSTRAINT "PurchaseReceipt_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseReceiptItem"
ADD CONSTRAINT "PurchaseReceiptItem_purchaseReceiptId_fkey" FOREIGN KEY ("purchaseReceiptId") REFERENCES "PurchaseReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchaseReceiptItem"
ADD CONSTRAINT "PurchaseReceiptItem_purchaseOrderItemId_fkey" FOREIGN KEY ("purchaseOrderItemId") REFERENCES "PurchaseOrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
