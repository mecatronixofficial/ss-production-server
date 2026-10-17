-- Finished fabric from a batch goes to customers and / or into warehouses (as stock under the batch's code).
CREATE TYPE "FabricDeliveryDestination" AS ENUM ('CUSTOMER', 'WAREHOUSE');

CREATE TABLE "FabricFlowDelivery" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3) NOT NULL,
    "destination" "FabricDeliveryDestination" NOT NULL,
    "customerId" TEXT,
    "warehouseId" TEXT,
    "weightKg" DECIMAL(14,3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "expense" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "stockTxnId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FabricFlowDelivery_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FabricFlowDelivery_flowId_idx" ON "FabricFlowDelivery"("flowId");
ALTER TABLE "FabricFlowDelivery" ADD CONSTRAINT "FabricFlowDelivery_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "FabricProductionFlow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FabricFlowDelivery" ADD CONSTRAINT "FabricFlowDelivery_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FabricFlowDelivery" ADD CONSTRAINT "FabricFlowDelivery_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;
