import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { Request } from 'express';
import { AuthUser } from '../common/auth-user';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { ADMIN_ROLES } from '../common/roles';
import { ExpenseDto } from './dto/finance.dto';
import {
  CancelMoneyTxnDto,
  ChequeActionDto,
  ExpenseFilterDto,
  MoneyAccountDto,
  MoneyTxnDto,
  MoneyTxnFilterDto,
  StatementQueryDto,
  UpdateMoneyAccountDto,
} from './dto/money.dto';
import { MoneyService } from './money.service';

/** Money management: admins only. Seeing a full bank account number is for a super admin, and is audited. */
@Controller('money')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(...ADMIN_ROLES)
export class MoneyController {
  constructor(private readonly money: MoneyService) {}

  @Get('summary') summary() {
    return this.money.summary();
  }

  @Get('context') context() {
    return this.money.context();
  }

  /** Whether bank account numbers can be saved and read on this server (no key details). */
  @Get('security') security() {
    return this.money.encryptionStatus();
  }

  @Get('accounts') accounts() {
    return this.money.accounts();
  }

  @Post('accounts') createAccount(@Body() dto: MoneyAccountDto, @CurrentUser() user: AuthUser) {
    return this.money.createAccount(dto, user);
  }

  @Patch('accounts/:id') updateAccount(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMoneyAccountDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.money.updateAccount(id, dto, user);
  }

  /** POST so it is never cached or prefetched; at most 5 a minute. */
  @Post('accounts/:id/reveal')
  @Roles(Role.SUPERADMIN)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  reveal(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.money.revealAccountNo(id, user, req.ip, req.get('user-agent')?.slice(0, 300));
  }

  @Get('transactions') transactions(@Query() filter: MoneyTxnFilterDto) {
    return this.money.transactions(filter);
  }

  @Get('transactions/:id') findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.money.findOne(id);
  }

  @Post('transactions')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  create(@Body() dto: MoneyTxnDto, @CurrentUser() user: AuthUser) {
    return this.money.create(dto, user);
  }

  @Post('transactions/:id/cancel') cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelMoneyTxnDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.money.cancel(id, dto.reason, user);
  }

  @Post('transactions/:id/cheque') cheque(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChequeActionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.money.chequeAction(id, dto, user);
  }

  /** Every distributor and textile with what they owe / are owed. */
  @Get('parties') parties() {
    return this.money.parties();
  }

  @Get('statement') statement(@Query() query: StatementQueryDto) {
    return this.money.statement(query);
  }

  /** One account's cash book with running balance. */
  @Get('accounts/:id/cashbook') cashbook(@Param('id', ParseUUIDPipe) id: string) {
    return this.money.cashbook(id);
  }

  @Get('expenses') expenses(@Query() filter: ExpenseFilterDto) {
    return this.money.expenses(filter);
  }

  @Post('expenses')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  addExpense(@Body() dto: ExpenseDto, @CurrentUser() user: AuthUser) {
    return this.money.addExpense(dto, user);
  }

  @Post('expenses/:id/cancel') cancelExpense(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelMoneyTxnDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.money.cancelExpense(id, dto.reason, user);
  }
}
