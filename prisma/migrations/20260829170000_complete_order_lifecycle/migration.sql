-- Add explicit sales-order dispatch states.
ALTER TYPE "OrderStatus" ADD VALUE 'PARTIALLY_DISPATCHED';
ALTER TYPE "OrderStatus" ADD VALUE 'DISPATCHED';

-- Track packing and receivable lifecycles independently from the sales order.
CREATE TYPE "PackingStatus" AS ENUM ('PACKED', 'DISPATCHED', 'CANCELLED');
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED');

ALTER TABLE "PackingList"
ADD COLUMN "status" "PackingStatus" NOT NULL DEFAULT 'PACKED';

ALTER TABLE "Invoice"
ADD COLUMN "status" "InvoiceStatus" NOT NULL DEFAULT 'ISSUED';

CREATE INDEX "Invoice_status_dueDate_idx" ON "Invoice"("status", "dueDate");
