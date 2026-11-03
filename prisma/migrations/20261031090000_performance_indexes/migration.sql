-- Indexes for the reads every page load makes: a warehouse's stock and history, the dashboard's delivery and sale
-- figures, and the production updates in the notification list.
CREATE INDEX "StockTransaction_warehouseId_createdAt_idx" ON "StockTransaction"("warehouseId", "createdAt");
CREATE INDEX "Notification_userId_type_createdAt_idx" ON "Notification"("userId", "type", "createdAt");
CREATE INDEX "FabricFlowDelivery_processStage_destination_deliveredAt_idx" ON "FabricFlowDelivery"("processStage", "destination", "deliveredAt");
CREATE INDEX "Sale_status_saleDate_idx" ON "Sale"("status", "saleDate");
CREATE INDEX "Sale_status_dispatchedAt_idx" ON "Sale"("status", "dispatchedAt");
