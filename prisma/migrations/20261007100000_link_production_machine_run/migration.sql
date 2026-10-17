ALTER TABLE "KnittingRun" ADD COLUMN "productionFlowId" TEXT;
CREATE UNIQUE INDEX "KnittingRun_productionFlowId_key" ON "KnittingRun"("productionFlowId");
ALTER TABLE "KnittingRun" ADD CONSTRAINT "KnittingRun_productionFlowId_fkey" FOREIGN KEY ("productionFlowId") REFERENCES "FabricProductionFlow"("id") ON DELETE SET NULL ON UPDATE CASCADE;
