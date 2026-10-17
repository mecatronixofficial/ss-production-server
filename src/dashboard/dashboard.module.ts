import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
@Module({ imports: [FinanceModule], controllers: [DashboardController], providers: [DashboardService] })
export class DashboardModule {}
