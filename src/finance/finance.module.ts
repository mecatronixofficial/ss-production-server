import { Module } from '@nestjs/common';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';
import { MoneyController } from './money.controller';
import { MoneyService } from './money.service';

@Module({
  controllers: [FinanceController, MoneyController],
  providers: [FinanceService, MoneyService],
  exports: [FinanceService, MoneyService],
})
export class FinanceModule {}
