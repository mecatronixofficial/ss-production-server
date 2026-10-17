import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { KnittingController } from './knitting.controller';
import { KnittingService } from './knitting.service';

@Module({ imports: [InventoryModule], controllers: [KnittingController], providers: [KnittingService] })
export class KnittingModule {}
