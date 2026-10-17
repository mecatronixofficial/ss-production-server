import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({ imports: [FinanceModule], controllers: [ReportsController], providers: [ReportsService] })
export class ReportsModule {}
