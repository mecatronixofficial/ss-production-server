import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { StorageModule } from '../storage/storage.module';
import { ProductionController } from './production.controller';
import { ProductionService } from './production.service';

@Module({ imports: [InventoryModule, StorageModule], controllers: [ProductionController], providers: [ProductionService] })
export class ProductionModule {}
