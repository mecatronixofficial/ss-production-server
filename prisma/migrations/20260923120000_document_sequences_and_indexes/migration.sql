-- CreateTable
CREATE TABLE "DocumentSequence" (
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentSequence_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "RefreshSession_expiresAt_idx" ON "RefreshSession"("expiresAt");

-- CreateIndex
CREATE INDEX "SalesOrder_status_idx" ON "SalesOrder"("status");

-- CreateIndex
CREATE INDEX "ProductionOrder_status_dueDate_idx" ON "ProductionOrder"("status", "dueDate");

-- CreateIndex
CREATE INDEX "YarnProductionEntry_approved_createdAt_idx" ON "YarnProductionEntry"("approved", "createdAt");

-- CreateIndex
CREATE INDEX "YarnProductionEntry_createdAt_idx" ON "YarnProductionEntry"("createdAt");

-- CreateIndex
CREATE INDEX "KnittingJob_assignedWorkerId_status_idx" ON "KnittingJob"("assignedWorkerId", "status");

-- CreateIndex
CREATE INDEX "KnittingProductionEntry_knittingJobId_idx" ON "KnittingProductionEntry"("knittingJobId");

-- CreateIndex
CREATE INDEX "KnittingProductionEntry_approved_createdAt_idx" ON "KnittingProductionEntry"("approved", "createdAt");

-- CreateIndex
CREATE INDEX "KnittingProductionEntry_createdAt_idx" ON "KnittingProductionEntry"("createdAt");

-- CreateIndex
CREATE INDEX "GreyFabricRoll_knittingJobId_idx" ON "GreyFabricRoll"("knittingJobId");

-- CreateIndex
CREATE INDEX "GreyFabricRoll_qcStatus_idx" ON "GreyFabricRoll"("qcStatus");

-- CreateIndex
CREATE INDEX "DyeingBatch_assignedWorkerId_status_idx" ON "DyeingBatch"("assignedWorkerId", "status");

-- CreateIndex
CREATE INDEX "DyeingBatchRoll_greyRollId_idx" ON "DyeingBatchRoll"("greyRollId");

-- CreateIndex
CREATE INDEX "DyeingEntry_batchId_idx" ON "DyeingEntry"("batchId");

-- CreateIndex
CREATE INDEX "DyeingEntry_approved_createdAt_idx" ON "DyeingEntry"("approved", "createdAt");

-- CreateIndex
CREATE INDEX "DyeingEntry_createdAt_idx" ON "DyeingEntry"("createdAt");

-- CreateIndex
CREATE INDEX "FinishingJob_productionOrderId_idx" ON "FinishingJob"("productionOrderId");

-- CreateIndex
CREATE INDEX "QualityInspection_productionOrderId_idx" ON "QualityInspection"("productionOrderId");

-- CreateIndex
CREATE INDEX "QualityInspection_status_idx" ON "QualityInspection"("status");

-- CreateIndex
CREATE INDEX "FinishedFabricRoll_productionOrderId_idx" ON "FinishedFabricRoll"("productionOrderId");

-- CreateIndex
CREATE INDEX "FinishedFabricRoll_qcStatus_idx" ON "FinishedFabricRoll"("qcStatus");

-- CreateIndex
CREATE INDEX "PackingList_salesOrderId_status_idx" ON "PackingList"("salesOrderId", "status");

-- CreateIndex
CREATE INDEX "PackingListItem_rollId_idx" ON "PackingListItem"("rollId");

-- CreateIndex
CREATE INDEX "Dispatch_salesOrderId_status_idx" ON "Dispatch"("salesOrderId", "status");

-- CreateIndex
CREATE INDEX "Dispatch_packingListId_idx" ON "Dispatch"("packingListId");

-- CreateIndex
CREATE INDEX "Dispatch_invoiceId_idx" ON "Dispatch"("invoiceId");

-- CreateIndex
CREATE INDEX "Dispatch_status_idx" ON "Dispatch"("status");

-- CreateIndex
CREATE INDEX "Delivery_dispatchId_idx" ON "Delivery"("dispatchId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_supplierId_idx" ON "PurchaseOrder"("supplierId");

-- CreateIndex
CREATE INDEX "Invoice_salesOrderId_idx" ON "Invoice"("salesOrderId");

-- CreateIndex
CREATE INDEX "Invoice_customerId_idx" ON "Invoice"("customerId");

-- CreateIndex
CREATE INDEX "CustomerPayment_invoiceId_idx" ON "CustomerPayment"("invoiceId");

-- CreateIndex
CREATE INDEX "CustomerPayment_customerId_paidAt_idx" ON "CustomerPayment"("customerId", "paidAt");

-- CreateIndex
CREATE INDEX "Expense_expenseDate_idx" ON "Expense"("expenseDate");

-- CreateIndex
CREATE INDEX "WasteEntry_productionOrderId_idx" ON "WasteEntry"("productionOrderId");

-- CreateIndex
CREATE INDEX "WasteEntry_createdAt_idx" ON "WasteEntry"("createdAt");

-- CreateIndex
CREATE INDEX "StockTransaction_createdAt_idx" ON "StockTransaction"("createdAt");

-- CreateIndex
CREATE INDEX "MaintenanceRecord_machineId_endedAt_idx" ON "MaintenanceRecord"("machineId", "endedAt");

-- CreateIndex
CREATE INDEX "MaintenanceRecord_startedAt_idx" ON "MaintenanceRecord"("startedAt");


-- Start each yearly counter after any existing sequential number
-- (e.g. demo data "SO-2026-000001") so new documents never collide.
-- Older timestamp-based numbers use 8 digits and cannot clash with the
-- 6-digit sequence format.
INSERT INTO "DocumentSequence" ("key", "value", "updatedAt")
SELECT substring(no FROM '^([A-Z]+-[0-9]{4})-'), MAX(substring(no FROM '([0-9]{6})$')::INTEGER), NOW()
FROM (
  SELECT "orderNo" AS no FROM "SalesOrder"
  UNION ALL SELECT "productionNo" FROM "ProductionOrder"
  UNION ALL SELECT "entryNo" FROM "YarnProductionEntry"
  UNION ALL SELECT "jobNo" FROM "KnittingJob"
  UNION ALL SELECT "rollNo" FROM "GreyFabricRoll"
  UNION ALL SELECT "batchNo" FROM "DyeingBatch"
  UNION ALL SELECT "jobNo" FROM "FinishingJob"
  UNION ALL SELECT "inspectionNo" FROM "QualityInspection"
  UNION ALL SELECT "rollNo" FROM "FinishedFabricRoll"
  UNION ALL SELECT "packingNo" FROM "PackingList"
  UNION ALL SELECT "dispatchNo" FROM "Dispatch"
  UNION ALL SELECT "deliveryNo" FROM "Delivery"
  UNION ALL SELECT "poNo" FROM "PurchaseOrder"
  UNION ALL SELECT "receiptNo" FROM "PurchaseReceipt"
  UNION ALL SELECT "invoiceNo" FROM "Invoice"
  UNION ALL SELECT "expenseNo" FROM "Expense"
  UNION ALL SELECT "flowNo" FROM "FabricProductionFlow"
) AS documents
WHERE no ~ '^[A-Z]+-[0-9]{4}-[0-9]{6}$'
GROUP BY 1
ON CONFLICT ("key") DO UPDATE SET "value" = GREATEST("DocumentSequence"."value", EXCLUDED."value");
