CREATE TABLE "FabricFlowExpense" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "expenseDate" TIMESTAMP(3) NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FabricFlowExpense_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FabricFlowExpense_flowId_expenseDate_idx" ON "FabricFlowExpense"("flowId", "expenseDate");
ALTER TABLE "FabricFlowExpense" ADD CONSTRAINT "FabricFlowExpense_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "FabricProductionFlow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
