import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { KnittingModule } from '../knitting/knitting.module';
import { StorageModule } from '../storage/storage.module';
import { ProductionController } from './production.controller';
import { ProductionService } from './production.service';
import { ProcessChallansService } from './process-challans';

@Module({ imports: [InventoryModule, StorageModule, KnittingModule], controllers: [ProductionController], providers: [ProductionService, ProcessChallansService] })
export class ProductionModule {}
