-- Delivery challans for a production batch's fabric moving between processes, warehouses and parties (PDC-<year>-<6 digits>).
-- CreateTable
CREATE TABLE "ProcessChallan" (
    "id" TEXT NOT NULL,
    "challanNo" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "handOff" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "material" TEXT NOT NULL,
    "fromKind" TEXT NOT NULL,
    "fromName" TEXT NOT NULL,
    "toKind" TEXT NOT NULL,
    "toName" TEXT NOT NULL,
    "weightKg" DECIMAL(14,3) NOT NULL,
    "packages" INTEGER,
    "packageUnit" TEXT,
    "vehicleNo" TEXT,
    "driverName" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcessChallan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProcessChallan_challanNo_key" ON "ProcessChallan"("challanNo");

-- CreateIndex
CREATE INDEX "ProcessChallan_date_idx" ON "ProcessChallan"("date");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessChallan_flowId_handOff_key" ON "ProcessChallan"("flowId", "handOff");

-- AddForeignKey
ALTER TABLE "ProcessChallan" ADD CONSTRAINT "ProcessChallan_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "FabricProductionFlow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

