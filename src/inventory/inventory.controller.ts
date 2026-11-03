import {
  BadRequestException,
  Body,
  NotFoundException,
  Controller,
  Delete,
  Get,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Patch,
  PipeTransform,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { StockBillKind, StockCategory } from '@prisma/client';
import { AuthUser } from '../common/auth-user';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { ADMIN_ROLES, GODOWN_ROLES, GODOWN_VIEW_ROLES } from '../common/roles';
import { GodownEntryDto } from './dto/godown-entry.dto';
import { CancelStockBillDto, ClearUnbilledDto, CreateStockBillDto, IssueAllStockBillsDto } from './dto/stock-bill.dto';
import { InventoryService } from './inventory.service';
import { StockBillsService } from './stock-bills.service';
import { challanPdf } from './challan-pdf';
import { yarnAtKnitting } from './yarn-usage';
import { yarnStory } from './yarn-story';
import { PrismaService } from '../prisma/prisma.service';

const categoryPipe = new ParseEnumPipe(StockCategory, { optional: true });
const optionalUuid = new ParseUUIDPipe({ optional: true });
const kindPipe = new ParseEnumPipe(StockBillKind, { optional: true });
/** An optional ISO date-time query value. */
const optionalDate: PipeTransform<string | undefined, Date | undefined> = {
  transform(value) {
    if (!value) return undefined;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new BadRequestException('Dates must be ISO date-times');
    return date;
  },
};

@Controller('inventory')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(...GODOWN_VIEW_ROLES)
export class InventoryController {
  constructor(
    private s: InventoryService,
    private bills: StockBillsService,
    private prisma: PrismaService,
  ) {}

  /** Yarn out at knitting, by batch: where it is (mill or machines), given, used so far and left; `warehouseId` for one warehouse's. */
  @Get('yarn-at-knitting')
  yarnAtKnitting(@Query('warehouseId', optionalUuid) warehouseId?: string) {
    return yarnAtKnitting(this.prisma, warehouseId);
  }

  @Get('balances')
  balances(
    @Query('category', categoryPipe) category?: StockCategory,
    @Query('itemCode') itemCode?: string,
    @Query('lotNo') lotNo?: string,
    @Query('warehouseId', optionalUuid) warehouseId?: string,
  ) {
    return this.s.balance({ category, itemCode, lotNo, warehouseId });
  }

  /** One warehouse's stock by item code: received, sold, otherwise issued and in stock now. */
  @Get('items-summary')
  itemsSummary(
    @Query('warehouseId', ParseUUIDPipe) warehouseId: string,
    @Query('from', optionalDate) from?: Date,
    @Query('to', optionalDate) to?: Date,
  ) {
    return this.s.itemSummary(warehouseId, from, to);
  }

  /**
   * The yarn tree behind a code (a yarn, a knitting batch, a dyeing lot or a machine run): the yarn, each knitting
   * batch, each colour's dyeing, compacting and where it was delivered, with the weight checked at every step.
   */
  @Get('yarn-story')
  async yarnTree(@Query('code') code?: string) {
    if (!code?.trim()) throw new BadRequestException('Give a yarn code');
    const story = await yarnStory(this.prisma, code.trim());
    if (!story) throw new NotFoundException(`${code.trim()} has no production behind it`);
    return story;
  }

  /** One item's full details. The code goes in the query: codes can hold spaces, colons and slashes. */
  @Get('item')
  item(@CurrentUser() user: AuthUser, @Query('code') code?: string) {
    if (!code?.trim()) throw new BadRequestException('Give an item code');
    // Rates, costs and sale amounts only for admins.
    return this.s.itemDetails(code.trim(), { prices: ADMIN_ROLES.includes(user.role) });
  }

  /** `from` / `to` are ISO date-times (the page sends the start and end of the chosen local days). */
  @Get('ledger')
  ledger(
    @Query('category', categoryPipe) category?: StockCategory,
    @Query('itemCode') itemCode?: string,
    @Query('lotNo') lotNo?: string,
    @Query('warehouseId', optionalUuid) warehouseId?: string,
    @Query('from', optionalDate) from?: Date,
    @Query('to', optionalDate) to?: Date,
  ) {
    return this.s.ledger({ category, itemCode, lotNo, warehouseId, from, to });
  }

  @Post('entries') @Roles(...GODOWN_ROLES) createEntry(@Body() dto: GodownEntryDto, @CurrentUser() user: AuthUser) {
    return this.s.createEntry(dto, user);
  }

  @Patch('entries/:id') @Roles(...GODOWN_ROLES) updateEntry(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GodownEntryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.s.updateEntry(id, dto, user);
  }

  @Delete('entries/:id') @Roles(...GODOWN_ROLES) deleteEntry(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.s.deleteEntry(id, user);
  }

  // ─── Received / export challans: issued automatically with every movement; opened, printed and shared by anyone
  // who sees the warehouse; cancelled (or issued for movements still waiting) by admins.

  /** One warehouse's challans and how many of its movements have none yet; every warehouse's for admins (the register). */
  @Get('bills')
  billList(
    @CurrentUser() user: AuthUser,
    @Query('warehouseId', optionalUuid) warehouseId?: string,
    @Query('from', optionalDate) from?: Date,
    @Query('to', optionalDate) to?: Date,
    @Query('kind', kindPipe) kind?: StockBillKind,
  ) {
    if (!warehouseId && !ADMIN_ROLES.includes(user.role)) throw new BadRequestException('Choose a warehouse');
    return this.bills.list({ warehouseId, from, to, kind });
  }

  /** Only how many movements have no challan yet (one warehouse's, or every one's for admins): the Warehouses page's count. */
  @Get('bills/unbilled-count')
  billUnbilledCount(@CurrentUser() user: AuthUser, @Query('warehouseId', optionalUuid) warehouseId?: string) {
    if (!warehouseId && !ADMIN_ROLES.includes(user.role)) throw new BadRequestException('Choose a warehouse');
    return this.bills.unbilledCount(warehouseId);
  }

  @Get('bills/:id')
  bill(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.bills.findOne(id, { prices: ADMIN_ROLES.includes(user.role) });
  }

  /** The challan as a PDF, to share or print. */
  @Get('bills/:id/pdf')
  async billPdf(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    const challan = await this.bills.findOne(id, { prices: ADMIN_ROLES.includes(user.role) });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${challan.billNo}.pdf"` });
    return new StreamableFile(await challanPdf(challan));
  }

  /** Admins: issue challans for every movement still waiting for one (one warehouse, or all). */
  @Post('bills/issue-all') @Roles(...ADMIN_ROLES) issueAll(@Body() dto: IssueAllStockBillsDto, @CurrentUser() user: AuthUser) {
    return this.bills.issueAll(dto.warehouseId, user);
  }

  @Post('bills') @Roles(...ADMIN_ROLES) createBill(@Body() dto: CreateStockBillDto, @CurrentUser() user: AuthUser) {
    return this.bills.create(dto, user);
  }

  /** Admins: clear old movements without a bill as needing none. */
  @Post('bills/clear-unbilled') @Roles(...ADMIN_ROLES) clearUnbilled(@Body() dto: ClearUnbilledDto, @CurrentUser() user: AuthUser) {
    return this.bills.clearUnbilled(dto.warehouseId, dto.before ? new Date(dto.before) : undefined, user);
  }

  @Post('bills/:id/cancel') @Roles(...ADMIN_ROLES) cancelBill(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelStockBillDto, @CurrentUser() user: AuthUser) {
    return this.bills.cancel(id, dto.reason ?? '', user);
  }
}
