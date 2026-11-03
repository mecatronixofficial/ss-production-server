-- The day-end entry records the yarn each machine used, besides the fabric and rolls.
ALTER TABLE "KnittingDayEntry" ADD COLUMN "yarnUsedKg" DECIMAL(14,3);
