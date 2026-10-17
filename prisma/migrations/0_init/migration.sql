-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPERADMIN', 'MANAGER', 'WORKER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'LOCKED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'PLANNING', 'IN_PRODUCTION', 'PARTIALLY_COMPLETED', 'READY', 'PARTIALLY_DELIVERED', 'DELIVERED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PLANNED', 'WAITING', 'MATERIAL_ISSUED', 'RUNNING', 'PAUSED', 'QC_PENDING', 'COMPLETED', 'HOLD', 'REWORK', 'REJECTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "QcStatus" AS ENUM ('PENDING', 'PASSED', 'HOLD', 'REWORK', 'REJECTED');

-- CreateEnum
CREATE TYPE "StockCategory" AS ENUM ('RAW_MATERIAL', 'YARN', 'GREY_FABRIC', 'CHEMICAL', 'FINISHED_FABRIC', 'PACKING');

-- CreateEnum
CREATE TYPE "StockTxnType" AS ENUM ('OPENING', 'PURCHASE_IN', 'PRODUCTION_IN', 'PRODUCTION_ISSUE', 'KNITTING_ISSUE', 'KNITTING_RETURN', 'GREY_FABRIC_IN', 'DYEING_ISSUE', 'DYEING_OUTPUT', 'FINISHING_OUTPUT', 'QC_APPROVED', 'DISPATCH_OUT', 'RETURN_IN', 'TRANSFER_IN', 'TRANSFER_OUT', 'WASTE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "NotificationPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('JOB_ASSIGNED', 'JOB_STARTED', 'JOB_COMPLETED', 'QC_FAILED', 'QC_PASSED', 'HIGH_WASTAGE', 'LOW_STOCK', 'STOCK_DIFFERENCE', 'MACHINE_BREAKDOWN', 'MAINTENANCE_DUE', 'DELIVERY_DUE', 'DELIVERY_DELAYED', 'PAYMENT_DUE', 'ORDER_DUE', 'ORDER_COMPLETED', 'SYSTEM');

-- CreateEnum
CREATE TYPE "MachineStatus" AS ENUM ('RUNNING', 'IDLE', 'MAINTENANCE', 'BREAKDOWN', 'DISABLED');

-- CreateEnum
CREATE TYPE "DispatchStatus" AS ENUM ('READY', 'DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'RETURNED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "employeeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "company" TEXT,
    "contactPerson" TEXT,
    "mobile" TEXT,
    "email" TEXT,
    "gst" TEXT,
    "billingAddress" TEXT,
    "shippingAddress" TEXT,
    "state" TEXT,
    "city" TEXT,
    "creditLimit" DECIMAL(14,2),
    "paymentTerms" TEXT,
    "openingBalance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "company" TEXT,
    "contactPerson" TEXT,
    "mobile" TEXT,
    "email" TEXT,
    "gst" TEXT,
    "address" TEXT,
    "materialCategory" TEXT,
    "paymentTerms" TEXT,
    "openingBalance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Warehouse" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mobile" TEXT,
    "department" TEXT NOT NULL,
    "shift" TEXT,
    "joiningDate" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Machine" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "type" TEXT,
    "capacityKg" DECIMAL(12,3),
    "manufacturer" TEXT,
    "purchaseDate" TIMESTAMP(3),
    "status" "MachineStatus" NOT NULL DEFAULT 'IDLE',
    "operatorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Machine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesOrder" (
    "id" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "poNumber" TEXT,
    "orderDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expectedDelivery" TIMESTAMP(3),
    "status" "OrderStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesOrderItem" (
    "id" TEXT NOT NULL,
    "salesOrderId" TEXT NOT NULL,
    "fabricType" TEXT NOT NULL,
    "yarnType" TEXT NOT NULL,
    "yarnCount" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "gsm" INTEGER,
    "diameter" TEXT,
    "width" TEXT,
    "quantityKg" DECIMAL(14,3) NOT NULL,
    "rate" DECIMAL(14,2),
    "amount" DECIMAL(14,2),

    CONSTRAINT "SalesOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionOrder" (
    "id" TEXT NOT NULL,
    "productionNo" TEXT NOT NULL,
    "salesOrderId" TEXT NOT NULL,
    "salesOrderItemId" TEXT NOT NULL,
    "plannedQtyKg" DECIMAL(14,3) NOT NULL,
    "requiredYarnKg" DECIMAL(14,3) NOT NULL,
    "expectedKnittingLossPct" DECIMAL(5,2) NOT NULL DEFAULT 2,
    "expectedDyeingLossPct" DECIMAL(5,2) NOT NULL DEFAULT 3,
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "startDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "status" "JobStatus" NOT NULL DEFAULT 'PLANNED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductionOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YarnProductionEntry" (
    "id" TEXT NOT NULL,
    "entryNo" TEXT NOT NULL,
    "productionOrderId" TEXT NOT NULL,
    "processName" TEXT NOT NULL,
    "lotNo" TEXT NOT NULL,
    "yarnCount" TEXT NOT NULL,
    "machineCode" TEXT,
    "shift" TEXT,
    "workerId" TEXT,
    "inputKg" DECIMAL(14,3) NOT NULL,
    "outputKg" DECIMAL(14,3) NOT NULL,
    "wasteKg" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "balanceKg" DECIMAL(14,3) NOT NULL,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "YarnProductionEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YarnStockLot" (
    "id" TEXT NOT NULL,
    "lotNo" TEXT NOT NULL,
    "yarnType" TEXT NOT NULL,
    "yarnCount" TEXT NOT NULL,
    "color" TEXT,
    "coneCount" INTEGER NOT NULL DEFAULT 0,
    "netWeightKg" DECIMAL(14,3) NOT NULL,
    "warehouseCode" TEXT NOT NULL,
    "rack" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "YarnStockLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnittingJob" (
    "id" TEXT NOT NULL,
    "jobNo" TEXT NOT NULL,
    "productionOrderId" TEXT NOT NULL,
    "yarnLotNo" TEXT NOT NULL,
    "yarnCount" TEXT NOT NULL,
    "fabricType" TEXT NOT NULL,
    "gsm" INTEGER,
    "diameter" TEXT,
    "gauge" TEXT,
    "machineId" TEXT,
    "yarnIssuedKg" DECIMAL(14,3) NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PLANNED',
    "assignedWorkerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnittingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnittingProductionEntry" (
    "id" TEXT NOT NULL,
    "knittingJobId" TEXT NOT NULL,
    "workerId" TEXT,
    "shift" TEXT,
    "outputKg" DECIMAL(14,3) NOT NULL,
    "wasteKg" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "balanceKg" DECIMAL(14,3) NOT NULL,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnittingProductionEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GreyFabricRoll" (
    "id" TEXT NOT NULL,
    "rollNo" TEXT NOT NULL,
    "knittingJobId" TEXT NOT NULL,
    "fabricType" TEXT NOT NULL,
    "gsm" INTEGER,
    "diameter" TEXT,
    "width" TEXT,
    "weightKg" DECIMAL(14,3) NOT NULL,
    "qcStatus" "QcStatus" NOT NULL DEFAULT 'PENDING',
    "warehouseCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GreyFabricRoll_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DyeRecipe" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "shade" TEXT,
    "fabricType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DyeRecipe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chemical" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "minStock" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Chemical_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DyeRecipeItem" (
    "id" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "chemicalId" TEXT NOT NULL,
    "qtyPerKg" DECIMAL(14,6) NOT NULL,
    "unit" TEXT NOT NULL,

    CONSTRAINT "DyeRecipeItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DyeingBatch" (
    "id" TEXT NOT NULL,
    "batchNo" TEXT NOT NULL,
    "productionOrderId" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "shade" TEXT,
    "plannedQtyKg" DECIMAL(14,3) NOT NULL,
    "machineId" TEXT,
    "recipeId" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'PLANNED',
    "assignedWorkerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DyeingBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DyeingBatchRoll" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "greyRollId" TEXT NOT NULL,
    "inputKg" DECIMAL(14,3) NOT NULL,

    CONSTRAINT "DyeingBatchRoll_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DyeingEntry" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "workerId" TEXT,
    "processName" TEXT NOT NULL,
    "inputKg" DECIMAL(14,3) NOT NULL,
    "outputKg" DECIMAL(14,3) NOT NULL,
    "lossKg" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "rejectedKg" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "balanceKg" DECIMAL(14,3) NOT NULL,
    "temperature" DECIMAL(8,2),
    "durationMin" INTEGER,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DyeingEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinishingJob" (
    "id" TEXT NOT NULL,
    "jobNo" TEXT NOT NULL,
    "productionOrderId" TEXT NOT NULL,
    "processName" TEXT NOT NULL,
    "inputKg" DECIMAL(14,3) NOT NULL,
    "outputKg" DECIMAL(14,3) NOT NULL,
    "lossKg" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "gsmBefore" INTEGER,
    "gsmAfter" INTEGER,
    "widthBefore" TEXT,
    "widthAfter" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'PLANNED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinishingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QualityInspection" (
    "id" TEXT NOT NULL,
    "inspectionNo" TEXT NOT NULL,
    "productionOrderId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "status" "QcStatus" NOT NULL DEFAULT 'PENDING',
    "inputKg" DECIMAL(14,3) NOT NULL,
    "approvedKg" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "rejectedKg" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "reworkKg" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "inspectorId" TEXT,
    "measurements" JSONB,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QualityInspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinishedFabricRoll" (
    "id" TEXT NOT NULL,
    "rollNo" TEXT NOT NULL,
    "productionOrderId" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "shade" TEXT,
    "gsm" INTEGER,
    "width" TEXT,
    "netWeightKg" DECIMAL(14,3) NOT NULL,
    "qcStatus" "QcStatus" NOT NULL DEFAULT 'PASSED',
    "warehouseCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinishedFabricRoll_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackingList" (
    "id" TEXT NOT NULL,
    "packingNo" TEXT NOT NULL,
    "salesOrderId" TEXT NOT NULL,
    "packingType" TEXT,
    "netWeightKg" DECIMAL(14,3) NOT NULL,
    "grossWeightKg" DECIMAL(14,3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PackingList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackingListItem" (
    "id" TEXT NOT NULL,
    "packingListId" TEXT NOT NULL,
    "rollId" TEXT NOT NULL,
    "weightKg" DECIMAL(14,3) NOT NULL,

    CONSTRAINT "PackingListItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dispatch" (
    "id" TEXT NOT NULL,
    "dispatchNo" TEXT NOT NULL,
    "salesOrderId" TEXT NOT NULL,
    "packingListId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "dispatchDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vehicle" TEXT,
    "driver" TEXT,
    "transporter" TEXT,
    "lrNumber" TEXT,
    "totalWeightKg" DECIMAL(14,3) NOT NULL,
    "status" "DispatchStatus" NOT NULL DEFAULT 'READY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dispatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Delivery" (
    "id" TEXT NOT NULL,
    "deliveryNo" TEXT NOT NULL,
    "dispatchId" TEXT NOT NULL,
    "receivedKg" DECIMAL(14,3) NOT NULL,
    "shortageKg" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "damagedKg" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "returnedKg" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "deliveryDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "podObjectKey" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "poNo" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "orderDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expectedDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderItem" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "itemCode" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit" TEXT NOT NULL,
    "rate" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "PurchaseOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "invoiceNo" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "salesOrderId" TEXT,
    "taxableValue" DECIMAL(14,2) NOT NULL,
    "gstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(14,2) NOT NULL,
    "dueDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerPayment" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "mode" TEXT NOT NULL,
    "referenceNo" TEXT,
    "bank" TEXT,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "CustomerPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierPayment" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "mode" TEXT NOT NULL,
    "referenceNo" TEXT,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "expenseNo" TEXT NOT NULL,
    "expenseDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "category" TEXT NOT NULL,
    "subcategory" TEXT,
    "description" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "paymentMode" TEXT NOT NULL,
    "branch" TEXT,
    "attachmentKey" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WasteEntry" (
    "id" TEXT NOT NULL,
    "productionOrderId" TEXT,
    "process" TEXT NOT NULL,
    "quantityKg" DECIMAL(14,3) NOT NULL,
    "reason" TEXT NOT NULL,
    "machineCode" TEXT,
    "workerName" TEXT,
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WasteEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransaction" (
    "id" TEXT NOT NULL,
    "category" "StockCategory" NOT NULL,
    "txnType" "StockTxnType" NOT NULL,
    "itemCode" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "lotNo" TEXT,
    "warehouseId" TEXT NOT NULL,
    "quantityIn" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "quantityOut" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL DEFAULT 'KG',
    "referenceType" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "productionOrderId" TEXT,
    "createdById" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "priority" "NotificationPriority" NOT NULL DEFAULT 'NORMAL',
    "referenceType" TEXT,
    "referenceId" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "previousValue" JSONB,
    "newValue" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceRecord" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "complaint" TEXT NOT NULL,
    "technician" TEXT,
    "spareParts" TEXT,
    "cost" DECIMAL(14,2),
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenanceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_employeeId_key" ON "User"("employeeId");

-- CreateIndex
CREATE INDEX "RefreshSession_userId_expiresAt_idx" ON "RefreshSession"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_code_key" ON "Customer"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_code_key" ON "Supplier"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Warehouse_code_key" ON "Warehouse"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_code_key" ON "Employee"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Machine_code_key" ON "Machine"("code");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrder_orderNo_key" ON "SalesOrder"("orderNo");

-- CreateIndex
CREATE INDEX "SalesOrder_customerId_status_idx" ON "SalesOrder"("customerId", "status");

-- CreateIndex
CREATE INDEX "SalesOrder_orderDate_idx" ON "SalesOrder"("orderDate");

-- CreateIndex
CREATE INDEX "SalesOrderItem_salesOrderId_idx" ON "SalesOrderItem"("salesOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionOrder_productionNo_key" ON "ProductionOrder"("productionNo");

-- CreateIndex
CREATE INDEX "ProductionOrder_salesOrderId_status_idx" ON "ProductionOrder"("salesOrderId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "YarnProductionEntry_entryNo_key" ON "YarnProductionEntry"("entryNo");

-- CreateIndex
CREATE INDEX "YarnProductionEntry_productionOrderId_lotNo_idx" ON "YarnProductionEntry"("productionOrderId", "lotNo");

-- CreateIndex
CREATE UNIQUE INDEX "YarnStockLot_lotNo_key" ON "YarnStockLot"("lotNo");

-- CreateIndex
CREATE UNIQUE INDEX "KnittingJob_jobNo_key" ON "KnittingJob"("jobNo");

-- CreateIndex
CREATE INDEX "KnittingJob_productionOrderId_status_idx" ON "KnittingJob"("productionOrderId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "GreyFabricRoll_rollNo_key" ON "GreyFabricRoll"("rollNo");

-- CreateIndex
CREATE UNIQUE INDEX "Chemical_code_key" ON "Chemical"("code");

-- CreateIndex
CREATE UNIQUE INDEX "DyeingBatch_batchNo_key" ON "DyeingBatch"("batchNo");

-- CreateIndex
CREATE INDEX "DyeingBatch_productionOrderId_status_idx" ON "DyeingBatch"("productionOrderId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DyeingBatchRoll_batchId_greyRollId_key" ON "DyeingBatchRoll"("batchId", "greyRollId");

-- CreateIndex
CREATE UNIQUE INDEX "FinishingJob_jobNo_key" ON "FinishingJob"("jobNo");

-- CreateIndex
CREATE UNIQUE INDEX "QualityInspection_inspectionNo_key" ON "QualityInspection"("inspectionNo");

-- CreateIndex
CREATE UNIQUE INDEX "FinishedFabricRoll_rollNo_key" ON "FinishedFabricRoll"("rollNo");

-- CreateIndex
CREATE UNIQUE INDEX "PackingList_packingNo_key" ON "PackingList"("packingNo");

-- CreateIndex
CREATE UNIQUE INDEX "PackingListItem_packingListId_rollId_key" ON "PackingListItem"("packingListId", "rollId");

-- CreateIndex
CREATE UNIQUE INDEX "Dispatch_dispatchNo_key" ON "Dispatch"("dispatchNo");

-- CreateIndex
CREATE UNIQUE INDEX "Delivery_deliveryNo_key" ON "Delivery"("deliveryNo");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_poNo_key" ON "PurchaseOrder"("poNo");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_invoiceNo_key" ON "Invoice"("invoiceNo");

-- CreateIndex
CREATE UNIQUE INDEX "Expense_expenseNo_key" ON "Expense"("expenseNo");

-- CreateIndex
CREATE INDEX "StockTransaction_category_itemCode_warehouseId_idx" ON "StockTransaction"("category", "itemCode", "warehouseId");

-- CreateIndex
CREATE INDEX "StockTransaction_lotNo_idx" ON "StockTransaction"("lotNo");

-- CreateIndex
CREATE INDEX "StockTransaction_referenceType_referenceId_idx" ON "StockTransaction"("referenceType", "referenceId");

-- CreateIndex
CREATE INDEX "StockTransaction_productionOrderId_idx" ON "StockTransaction"("productionOrderId");

-- CreateIndex
CREATE INDEX "Notification_userId_isRead_createdAt_idx" ON "Notification"("userId", "isRead", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_module_createdAt_idx" ON "AuditLog"("module", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SystemSetting_key_key" ON "SystemSetting"("key");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshSession" ADD CONSTRAINT "RefreshSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrderItem" ADD CONSTRAINT "SalesOrderItem_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionOrder" ADD CONSTRAINT "ProductionOrder_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionOrder" ADD CONSTRAINT "ProductionOrder_salesOrderItemId_fkey" FOREIGN KEY ("salesOrderItemId") REFERENCES "SalesOrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YarnProductionEntry" ADD CONSTRAINT "YarnProductionEntry_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "ProductionOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YarnProductionEntry" ADD CONSTRAINT "YarnProductionEntry_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnittingJob" ADD CONSTRAINT "KnittingJob_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "ProductionOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnittingJob" ADD CONSTRAINT "KnittingJob_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnittingProductionEntry" ADD CONSTRAINT "KnittingProductionEntry_knittingJobId_fkey" FOREIGN KEY ("knittingJobId") REFERENCES "KnittingJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnittingProductionEntry" ADD CONSTRAINT "KnittingProductionEntry_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GreyFabricRoll" ADD CONSTRAINT "GreyFabricRoll_knittingJobId_fkey" FOREIGN KEY ("knittingJobId") REFERENCES "KnittingJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DyeRecipeItem" ADD CONSTRAINT "DyeRecipeItem_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "DyeRecipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DyeRecipeItem" ADD CONSTRAINT "DyeRecipeItem_chemicalId_fkey" FOREIGN KEY ("chemicalId") REFERENCES "Chemical"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DyeingBatch" ADD CONSTRAINT "DyeingBatch_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "ProductionOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DyeingBatch" ADD CONSTRAINT "DyeingBatch_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DyeingBatch" ADD CONSTRAINT "DyeingBatch_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "DyeRecipe"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DyeingBatchRoll" ADD CONSTRAINT "DyeingBatchRoll_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "DyeingBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DyeingBatchRoll" ADD CONSTRAINT "DyeingBatchRoll_greyRollId_fkey" FOREIGN KEY ("greyRollId") REFERENCES "GreyFabricRoll"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DyeingEntry" ADD CONSTRAINT "DyeingEntry_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "DyeingBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DyeingEntry" ADD CONSTRAINT "DyeingEntry_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinishingJob" ADD CONSTRAINT "FinishingJob_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "ProductionOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QualityInspection" ADD CONSTRAINT "QualityInspection_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "ProductionOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QualityInspection" ADD CONSTRAINT "QualityInspection_inspectorId_fkey" FOREIGN KEY ("inspectorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinishedFabricRoll" ADD CONSTRAINT "FinishedFabricRoll_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "ProductionOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackingList" ADD CONSTRAINT "PackingList_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackingListItem" ADD CONSTRAINT "PackingListItem_packingListId_fkey" FOREIGN KEY ("packingListId") REFERENCES "PackingList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackingListItem" ADD CONSTRAINT "PackingListItem_rollId_fkey" FOREIGN KEY ("rollId") REFERENCES "FinishedFabricRoll"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispatch" ADD CONSTRAINT "Dispatch_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispatch" ADD CONSTRAINT "Dispatch_packingListId_fkey" FOREIGN KEY ("packingListId") REFERENCES "PackingList"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispatch" ADD CONSTRAINT "Dispatch_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "Dispatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPayment" ADD CONSTRAINT "CustomerPayment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPayment" ADD CONSTRAINT "CustomerPayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WasteEntry" ADD CONSTRAINT "WasteEntry_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "ProductionOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransaction" ADD CONSTRAINT "StockTransaction_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceRecord" ADD CONSTRAINT "MaintenanceRecord_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
