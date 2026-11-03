import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { StockBillsService } from './stock-bills.service';
import { YarnReceiptsController } from './yarn-receipts.controller';
import { YarnReceiptsService } from './yarn-receipts.service';

@Module({ controllers: [InventoryController, YarnReceiptsController], providers: [InventoryService, StockBillsService, YarnReceiptsService], exports: [InventoryService] })
export class InventoryModule {}
