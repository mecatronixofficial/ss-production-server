-- Knitting machines: a knitting charge per KG, 240 KG yarn capacity by default, and runs of one to three yarns.

-- CreateEnum
CREATE TYPE "KnittingShift" AS ENUM ('DAY', 'NIGHT');

-- CreateEnum
CREATE TYPE "KnittingRunStatus" AS ENUM ('RUNNING', 'FINISHED');

-- AlterTable
ALTER TABLE "Machine" ADD COLUMN "ratePerKg" DECIMAL(12,2);

-- Machines without a capacity take the standard 240 KG load.
UPDATE "Machine" SET "capacityKg" = 240 WHERE "capacityKg" IS NULL;

-- CreateTable
CREATE TABLE "KnittingRun" (
    "id" TEXT NOT NULL,
    "runNo" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "status" "KnittingRunStatus" NOT NULL DEFAULT 'RUNNING',
    "fabricType" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "startShift" "KnittingShift" NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "finishShift" "KnittingShift",
    "operatorId" TEXT,
    "yarnKg" DECIMAL(14,3) NOT NULL,
    "yarnCost" DECIMAL(14,2) NOT NULL,
    "ratePerKg" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "outputKg" DECIMAL(14,3),
    "rollCount" INTEGER,
    "knittingCharge" DECIMAL(14,2),
    "warehouseId" TEXT,
    "stockTxnId" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnittingRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnittingRunYarn" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "itemCode" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "category" "StockCategory" NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "lotNo" TEXT,
    "kg" DECIMAL(14,3) NOT NULL,
    "ratePerKg" DECIMAL(12,2) NOT NULL,
    "issueTxnId" TEXT,

    CONSTRAINT "KnittingRunYarn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KnittingRun_runNo_key" ON "KnittingRun"("runNo");

-- CreateIndex
CREATE INDEX "KnittingRun_machineId_status_idx" ON "KnittingRun"("machineId", "status");

-- CreateIndex
CREATE INDEX "KnittingRun_startedAt_idx" ON "KnittingRun"("startedAt");

-- CreateIndex
CREATE INDEX "KnittingRunYarn_runId_idx" ON "KnittingRunYarn"("runId");

-- CreateIndex
CREATE INDEX "KnittingRunYarn_itemCode_idx" ON "KnittingRunYarn"("itemCode");

-- AddForeignKey
ALTER TABLE "KnittingRun" ADD CONSTRAINT "KnittingRun_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnittingRun" ADD CONSTRAINT "KnittingRun_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnittingRun" ADD CONSTRAINT "KnittingRun_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnittingRunYarn" ADD CONSTRAINT "KnittingRunYarn_runId_fkey" FOREIGN KEY ("runId") REFERENCES "KnittingRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnittingRunYarn" ADD CONSTRAINT "KnittingRunYarn_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
