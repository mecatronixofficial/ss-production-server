-- Processing Companies are now called Processing Factories. Rename in place so existing rows are kept.
ALTER TABLE "ProcessingCompany" RENAME TO "ProcessingFactory";
ALTER TABLE "ProcessingFactory" RENAME CONSTRAINT "ProcessingCompany_pkey" TO "ProcessingFactory_pkey";
ALTER INDEX "ProcessingCompany_code_key" RENAME TO "ProcessingFactory_code_key";
ALTER INDEX "ProcessingCompany_active_name_idx" RENAME TO "ProcessingFactory_active_name_idx";
