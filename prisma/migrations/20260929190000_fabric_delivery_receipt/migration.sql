-- Fabric sent into a warehouse now waits there until the warehouse receives it.
ALTER TABLE "FabricFlowDelivery"
  ADD COLUMN "receivedAt" TIMESTAMP(3),
  ADD COLUMN "receivedWeightKg" DECIMAL(14,3),
  ADD COLUMN "receivedById" TEXT;

-- Deliveries already put into stock count as received as sent.
UPDATE "FabricFlowDelivery"
SET "receivedAt" = "deliveredAt", "receivedWeightKg" = "weightKg"
WHERE "destination" = 'WAREHOUSE' AND "stockTxnId" IS NOT NULL;

CREATE INDEX "FabricFlowDelivery_warehouseId_receivedAt_idx" ON "FabricFlowDelivery"("warehouseId", "receivedAt");
