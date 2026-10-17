-- The mill sells through distributors, not customer accounts: customers, invoices, customer payments and
-- sales orders (with the old order-based production chain hanging off them) are removed.

-- Keep who each production delivery went to, as a typed party name, before customers are dropped.
ALTER TABLE "FabricFlowDelivery" ADD COLUMN "partyName" TEXT;
UPDATE "FabricFlowDelivery" AS d SET "partyName" = c."name" FROM "Customer" AS c WHERE d."customerId" = c."id";
ALTER TABLE "FabricFlowDelivery" DROP CONSTRAINT IF EXISTS "FabricFlowDelivery_customerId_fkey";
ALTER TABLE "FabricFlowDelivery" DROP COLUMN "customerId";

-- Stock movements no longer point at production orders.
DROP INDEX IF EXISTS "StockTransaction_productionOrderId_idx";
ALTER TABLE "StockTransaction" DROP COLUMN IF EXISTS "productionOrderId";

-- The order chain, children first.
DROP TABLE IF EXISTS
  "Delivery",
  "Dispatch",
  "PackingListItem",
  "PackingList",
  "FinishedFabricRoll",
  "QualityInspection",
  "FinishingJob",
  "DyeingEntry",
  "DyeingBatchRoll",
  "DyeingBatch",
  "GreyFabricRoll",
  "KnittingProductionEntry",
  "KnittingJob",
  "YarnProductionEntry",
  "WasteEntry",
  "ProductionOrder",
  "CustomerPayment",
  "Invoice",
  "SalesOrderItem",
  "SalesOrder",
  "Customer"
CASCADE;

DROP TYPE IF EXISTS "OrderStatus", "JobStatus", "QcStatus", "DispatchStatus", "PackingStatus", "InvoiceStatus";
