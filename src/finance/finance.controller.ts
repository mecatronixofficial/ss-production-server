import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { ADMIN_ROLES } from '../common/roles';
import { PeriodDto } from './dto/money.dto';
import { FinanceService } from './finance.service';

/**
 * Finance is read-only results for a period. Receipts, payments, expenses and transfers are recorded on the Money
 * page (`/money/*`).
 */
@Controller('finance')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(...ADMIN_ROLES)
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  @Get('summary') summary() {
    return this.finance.summary();
  }

  /** Earned vs spent, cash flow, month by month and the position now, for `from`..`to` (ISO date-times). */
  @Get('overview') overview(@Query() period: PeriodDto) {
    return this.finance.overview(period.from, period.to);
  }
}
