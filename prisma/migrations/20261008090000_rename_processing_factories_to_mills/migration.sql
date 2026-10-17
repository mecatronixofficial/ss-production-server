-- Processing Factories are now Mill Details. Rename in place so existing rows are kept.
ALTER TABLE "ProcessingFactory" RENAME TO "Mill";
ALTER TABLE "Mill" RENAME CONSTRAINT "ProcessingFactory_pkey" TO "Mill_pkey";
ALTER INDEX "ProcessingFactory_code_key" RENAME TO "Mill_code_key";
ALTER INDEX "ProcessingFactory_active_name_idx" RENAME TO "Mill_active_name_idx";
