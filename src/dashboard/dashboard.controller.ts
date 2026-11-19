import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { DashboardService, TREND_RANGES } from './dashboard.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { ADMIN_ROLES } from '../common/roles';
import { PiDetailsService } from './pi-details.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/auth-user';

const trendRange = (days?: string) => {
  const requested = Number(days);
  return (TREND_RANGES as readonly number[]).includes(requested) ? requested : 7;
};

@Controller('dashboard')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class DashboardController {
  constructor(
    private service: DashboardService,
    private pi: PiDetailsService,
  ) {}
  @Get() get(@CurrentUser() user: AuthUser, @Query('days') days?: string) {
    return this.service.get(user, trendRange(days));
  }
  @Get('pi-details')
  @Roles(...ADMIN_ROLES)
  piDetails(@Query('q') q?: string, @Query('page') page?: string) {
    return this.pi.get(q, page);
  }
  @Get('pi-details/:id')
  @Roles(...ADMIN_ROLES)
  piDetail(@Param('id', ParseUUIDPipe) id: string) {
    return this.pi.one(id);
  }
  /** The material-flow chart alone, for switching its range. */
  @Get('trend') trend(@Query('days') days?: string) {
    return this.service.trend(trendRange(days));
  }
}
