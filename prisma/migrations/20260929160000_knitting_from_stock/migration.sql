-- A production batch now starts when knitting takes yarn out of a warehouse by its item code.
ALTER TABLE "FabricProductionFlow"
  ADD COLUMN "yarnItemCode" TEXT,
  ADD COLUMN "yarnWarehouseId" TEXT,
  ADD COLUMN "yarnLotNo" TEXT,
  ADD COLUMN "yarnIssueTxnId" TEXT,
  ADD COLUMN "knittingExpectedFinishDate" TIMESTAMP(3),
  ADD COLUMN "knittingFinishedAt" TIMESTAMP(3),
  ADD COLUMN "knittingBagCount" INTEGER,
  ADD COLUMN "knittingDeliveryPlace" TEXT,
  ADD COLUMN "knittingNotes" TEXT;
ALTER TABLE "FabricProductionFlow"
  ADD CONSTRAINT "FabricProductionFlow_yarnWarehouseId_fkey" FOREIGN KEY ("yarnWarehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Knitting on older batches was recorded in one step; it counts as finished on its knitting date.
UPDATE "FabricProductionFlow" SET "knittingFinishedAt" = "knittingDate" WHERE "dyeingDeliveryKg" IS NOT NULL AND "knittingFinishedAt" IS NULL;

-- Documents and photos attached to a batch.
CREATE TABLE "FabricFlowAttachment" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FabricFlowAttachment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FabricFlowAttachment_flowId_stage_idx" ON "FabricFlowAttachment"("flowId", "stage");
ALTER TABLE "FabricFlowAttachment" ADD CONSTRAINT "FabricFlowAttachment_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "FabricProductionFlow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
