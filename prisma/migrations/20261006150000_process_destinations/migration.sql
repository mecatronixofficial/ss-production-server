CREATE TYPE "ProcessDeliveryDestination" AS ENUM ('NEXT_PROCESS', 'WAREHOUSE');

ALTER TABLE "FabricProductionFlow"
ADD COLUMN "knittingDestination" "ProcessDeliveryDestination" NOT NULL DEFAULT 'NEXT_PROCESS',
ADD COLUMN "knittingDestinationWarehouseId" TEXT,
ADD COLUMN "dyeingDestination" "ProcessDeliveryDestination" NOT NULL DEFAULT 'NEXT_PROCESS',
ADD COLUMN "dyeingDestinationWarehouseId" TEXT;
