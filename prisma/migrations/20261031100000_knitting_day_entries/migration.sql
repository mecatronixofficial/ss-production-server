-- Machines are no longer loaded up to a capacity: a task's work on a machine is recorded at the end of each production
-- day (KG and rolls), and a run can end because the work moved to another machine.
ALTER TABLE "KnittingRun" ADD COLUMN "endReason" TEXT;

CREATE TABLE "KnittingDayEntry" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "outputKg" DECIMAL(14,3) NOT NULL,
    "rollCount" INTEGER NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "stockTxnId" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnittingDayEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "KnittingDayEntry_date_idx" ON "KnittingDayEntry"("date");
CREATE UNIQUE INDEX "KnittingDayEntry_runId_date_key" ON "KnittingDayEntry"("runId", "date");

ALTER TABLE "KnittingDayEntry" ADD CONSTRAINT "KnittingDayEntry_runId_fkey" FOREIGN KEY ("runId") REFERENCES "KnittingRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "KnittingDayEntry" ADD CONSTRAINT "KnittingDayEntry_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
