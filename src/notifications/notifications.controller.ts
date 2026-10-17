import { BadRequestException, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/auth-user';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
@UseGuards(AuthGuard('jwt'))
export class NotificationsController {
  constructor(private s: NotificationsService) {}

  @Get() list(@CurrentUser() u: AuthUser) {
    return this.s.list(u.id);
  }
  /** New unread notifications since a moment (ISO date-time), to show as a message as they arrive. */
  @Get('latest') latest(@CurrentUser() u: AuthUser, @Query('since') since?: string) {
    const from = since ? new Date(since) : undefined;
    if (from && Number.isNaN(from.getTime())) throw new BadRequestException('since must be an ISO date-time');
    return this.s.latest(u.id, from);
  }
  @Get('unread-count') unreadCount(@CurrentUser() u: AuthUser) {
    return this.s.unreadCount(u.id);
  }
  @Patch('read-all') all(@CurrentUser() u: AuthUser) {
    return this.s.readAll(u.id);
  }
  @Patch(':id/read') read(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.s.read(u.id, id);
  }
  @Delete() removeAll(@CurrentUser() u: AuthUser) {
    return this.s.removeAll(u.id);
  }
  @Delete(':id') remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) {
    return this.s.remove(u.id, id);
  }
}
