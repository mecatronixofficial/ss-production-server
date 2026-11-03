import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthUser } from '../common/auth-user';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { ADMIN_ROLES, GODOWN_ROLES, GODOWN_VIEW_ROLES } from '../common/roles';
import { YarnReceiptDto } from './dto/yarn-receipt.dto';
import { YarnReceiptsService } from './yarn-receipts.service';

/** The yarn received register: the godown records each mill delivery; rates and amounts are for admins. */
@Controller('inventory/yarn-receipts')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(...GODOWN_VIEW_ROLES)
export class YarnReceiptsController {
  constructor(private s: YarnReceiptsService) {}

  /**
   * `?month=2026-10` that month's register; `?from=2026-10-01&to=2026-10-31` a range of days; `?all=1` every yarn ever
   * received. This month's when none is given.
   */
  @Get()
  register(
    @Query('month') month: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('all') all: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    const prices = { prices: ADMIN_ROLES.includes(user.role) };
    if (all === '1' || all === 'true') return this.s.register({}, prices);
    if (from?.trim() || to?.trim()) return this.s.register({ from: from?.trim() || undefined, to: to?.trim() || undefined }, prices);
    return this.s.register({ month: month?.trim() || new Date().toISOString().slice(0, 7) }, prices);
  }

  @Get('directory')
  directory() {
    return this.s.directory();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.s.findOne(id, { prices: ADMIN_ROLES.includes(user.role) });
  }

  @Post()
  @Roles(...GODOWN_ROLES)
  create(@Body() dto: YarnReceiptDto, @CurrentUser() user: AuthUser) {
    return this.s.create(dto, user, { prices: ADMIN_ROLES.includes(user.role) });
  }

  @Patch(':id')
  @Roles(...GODOWN_ROLES)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: YarnReceiptDto, @CurrentUser() user: AuthUser) {
    return this.s.update(id, dto, user, { prices: ADMIN_ROLES.includes(user.role) });
  }

  @Delete(':id')
  @Roles(...GODOWN_ROLES)
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.s.remove(id, user);
  }
}
