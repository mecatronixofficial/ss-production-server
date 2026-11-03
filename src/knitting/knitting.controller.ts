import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthUser } from '../common/auth-user';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { MACHINE_ROLES } from '../common/roles';
import { AssignMachinesDto, CompleteTaskDto, DayEntriesDto, FinishRunDto, MoveRunDto, StartRunDto } from './dto/knitting-run.dto';
import { KnittingService } from './knitting.service';

/** Knitting machines: tasks put on machines, production recorded day by day as grey fabric, machines changed or stopped. */
@Controller('knitting')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(...MACHINE_ROLES)
export class KnittingController {
  constructor(private service: KnittingService) {}

  @Get('context')
  context() {
    return this.service.context();
  }

  @Get('board')
  board() {
    return this.service.board();
  }

  @Get('runs')
  runs(@Query('code') code?: string, @Query('machineId', new ParseUUIDPipe({ optional: true })) machineId?: string) {
    return this.service.runs({ code: code?.slice(0, 80), machineId });
  }

  @Post('runs')
  start(@Body() dto: StartRunDto, @CurrentUser() user: AuthUser) {
    return this.service.start(dto, user);
  }

  @Post('tasks/:flowId/assign')
  assign(@Param('flowId', ParseUUIDPipe) flowId: string, @Body() dto: AssignMachinesDto, @CurrentUser() user: AuthUser) {
    return this.service.assign(flowId, dto, user);
  }

  @Post('tasks/:flowId/complete')
  completeTask(@Param('flowId', ParseUUIDPipe) flowId: string, @Body() dto: CompleteTaskDto, @CurrentUser() user: AuthUser) {
    return this.service.completeTask(flowId, dto, user);
  }

  @Post('days')
  recordDays(@Body() dto: DayEntriesDto, @CurrentUser() user: AuthUser) {
    return this.service.recordDays(dto, user);
  }

  @Delete('days/:id')
  deleteDay(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.deleteDay(id, user);
  }

  @Post('runs/:id/finish')
  finish(@Param('id', ParseUUIDPipe) id: string, @Body() dto: FinishRunDto, @CurrentUser() user: AuthUser) {
    return this.service.finish(id, dto, user);
  }

  @Post('runs/:id/move')
  move(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MoveRunDto, @CurrentUser() user: AuthUser) {
    return this.service.move(id, dto, user);
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
