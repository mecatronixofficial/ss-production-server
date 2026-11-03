-- The weight written on the mill's DC for each received count, to check the godown's weight against.
-- AlterTable
ALTER TABLE "YarnReceiptLine" ADD COLUMN "dcWeightKg" DECIMAL(14,3);
