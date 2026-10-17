-- CreateEnum
CREATE TYPE "MaintenanceType" AS ENUM ('PREVENTIVE', 'BREAKDOWN');

-- AlterTable
ALTER TABLE "MaintenanceRecord" ADD COLUMN     "type" "MaintenanceType" NOT NULL DEFAULT 'PREVENTIVE';
