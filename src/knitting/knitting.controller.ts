import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthUser } from '../common/auth-user';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { MACHINE_ROLES } from '../common/roles';
import { FinishRunDto, StartRunDto } from './dto/knitting-run.dto';
import { KnittingService } from './knitting.service';

/** Knitting machine runs: yarn loaded by item code, fabric off into a warehouse as grey fabric. */
@Controller('knitting')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(...MACHINE_ROLES)
export class KnittingController {
  constructor(private service: KnittingService) {}

  @Get('context')
  context() {
    return this.service.context();
  }

  @Get('runs')
  runs() {
    return this.service.runs();
  }

  @Post('runs')
  start(@Body() dto: StartRunDto, @CurrentUser() user: AuthUser) {
    return this.service.start(dto, user);
  }

  @Post('runs/:id/finish')
  finish(@Param('id', ParseUUIDPipe) id: string, @Body() dto: FinishRunDto, @CurrentUser() user: AuthUser) {
    return this.service.finish(id, dto, user);
  }

  @Post('runs/:id/reopen')
  reopen(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.reopen(id, user);
  }

  @Delete('runs/:id')
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.cancel(id, user);
  }
}
