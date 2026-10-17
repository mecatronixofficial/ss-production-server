-- Dyeing and compacting are started first and completed later, like knitting.
ALTER TABLE "FabricProductionFlow" ADD COLUMN "dyeingFinishedAt" TIMESTAMP(3);
ALTER TABLE "FabricProductionFlow" ADD COLUMN "compactingFinishedAt" TIMESTAMP(3);

-- Batches recorded before were started and completed in one go.
UPDATE "FabricProductionFlow" SET "dyeingFinishedAt" = "dyeingDate" WHERE "dyeingOutputWeightKg" IS NOT NULL AND "dyeingDate" IS NOT NULL;
UPDATE "FabricProductionFlow" SET "compactingFinishedAt" = "compactingDate" WHERE "officeDeliveryKg" IS NOT NULL AND "compactingDate" IS NOT NULL;
