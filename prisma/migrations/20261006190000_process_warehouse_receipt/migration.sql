ALTER TABLE "FabricFlowDelivery" ADD COLUMN "processStage" TEXT NOT NULL DEFAULT 'FINAL';
CREATE INDEX "FabricFlowDelivery_processStage_receivedAt_idx" ON "FabricFlowDelivery"("processStage", "receivedAt");
