-- Purchase-order lines no longer take a code when ordered: each gets its own SS-<year>-<n> code on its first receipt.
ALTER TABLE "PurchaseOrderItem" ALTER COLUMN "itemCode" DROP NOT NULL;
