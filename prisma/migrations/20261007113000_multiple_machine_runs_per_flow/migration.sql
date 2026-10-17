DROP INDEX IF EXISTS "KnittingRun_productionFlowId_key";
CREATE INDEX "KnittingRun_productionFlowId_status_idx" ON "KnittingRun"("productionFlowId", "status");
