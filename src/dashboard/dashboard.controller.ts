import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { DashboardService, TREND_RANGES } from './dashboard.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/auth-user';
@Controller('dashboard')
@UseGuards(AuthGuard('jwt'))
export class DashboardController {
  constructor(private service: DashboardService) {}
  @Get() get(@CurrentUser() user: AuthUser, @Query('days') days?: string) {
    const requested = Number(days);
    const trendDays = (TREND_RANGES as readonly number[]).includes(requested) ? requested : 7;
    return this.service.get(user, trendDays);
  }
}
