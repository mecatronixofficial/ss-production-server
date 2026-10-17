-- A purchase order names the warehouse its material goes to, so that warehouse can see what it is waiting for.
ALTER TABLE "PurchaseOrder" ADD COLUMN "warehouseId" TEXT;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "PurchaseOrder_warehouseId_status_idx" ON "PurchaseOrder"("warehouseId", "status");
