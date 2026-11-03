import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { DashboardService, TREND_RANGES } from './dashboard.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/auth-user';

const trendRange = (days?: string) => {
  const requested = Number(days);
  return (TREND_RANGES as readonly number[]).includes(requested) ? requested : 7;
};

@Controller('dashboard')
@UseGuards(AuthGuard('jwt'))
export class DashboardController {
  constructor(private service: DashboardService) {}
  @Get() get(@CurrentUser() user: AuthUser, @Query('days') days?: string) {
    return this.service.get(user, trendRange(days));
  }
  /** The material-flow chart alone, for switching its range. */
  @Get('trend') trend(@Query('days') days?: string) {
    return this.service.trend(trendRange(days));
  }
}
