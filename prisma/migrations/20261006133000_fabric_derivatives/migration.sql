ALTER TABLE "FabricProductionFlow"
ADD COLUMN "fabricType" TEXT,
ADD COLUMN "fabricDiameter" TEXT;

CREATE INDEX "FabricProductionFlow_yarnItemCode_createdAt_idx"
ON "FabricProductionFlow"("yarnItemCode", "createdAt");
