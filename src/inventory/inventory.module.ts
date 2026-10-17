import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { StockBillsService } from './stock-bills.service';

@Module({ controllers: [InventoryController], providers: [InventoryService, StockBillsService], exports: [InventoryService] })
export class InventoryModule {}
