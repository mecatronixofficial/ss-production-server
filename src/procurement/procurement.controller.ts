import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { Role } from '@prisma/client';
import { AuthUser } from '../common/auth-user';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { GODOWN_ROLES, GODOWN_VIEW_ROLES } from '../common/roles';
import { ClosePurchaseOrderDto, CreatePurchaseOrderDto, ReceivePurchaseOrderDto } from './dto/procurement.dto';
import { ProcurementService } from './procurement.service';
import { receivedChallanPdf } from './received-challan-pdf';

const isoDate = (value?: string) => {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new BadRequestException('Dates must be ISO date-times');
  return parsed;
};

@Controller('procurement')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(Role.SUPERADMIN, Role.ADMIN)
export class ProcurementController {
  constructor(private readonly procurement: ProcurementService) {}

  @Get('context')
  context() {
    return this.procurement.context();
  }

  @Get('purchase-orders')
  list(@CurrentUser() user: AuthUser) {
    return this.procurement.list(user);
  }

  @Get('purchase-orders/:id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.procurement.findOne(id, user);
  }

  /** Open POs being delivered to a warehouse; shown on its Warehouses page, where staff receive them (without rates). */
  @Get('incoming')
  @Roles(...GODOWN_VIEW_ROLES)
  incoming(@Query('warehouseId', ParseUUIDPipe) warehouseId: string, @CurrentUser() user: AuthUser) {
    return this.procurement.incoming(warehouseId, user);
  }

  /** Every received challan, newest first; `from` / `to` are ISO date-times. Office (admins) only. */
  @Get('receipts')
  receipts(@Query('from') from?: string, @Query('to') to?: string) {
    return this.procurement.receipts(isoDate(from), isoDate(to));
  }

  /** A goods receipt as its printable received challan: an office document, for admins only. */
  @Get('receipts/:id')
  receipt(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.procurement.receipt(id, user);
  }

  /** The received challan as a PDF, to share or print. */
  @Get('receipts/:id/pdf')
  async receiptPdf(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    const challan = await this.procurement.receipt(id, user);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${challan.receiptNo}.pdf"` });
    return new StreamableFile(await receivedChallanPdf(challan));
  }

  @Post('purchase-orders')
  create(@Body() dto: CreatePurchaseOrderDto, @CurrentUser() user: AuthUser) {
    return this.procurement.create(dto, user);
  }

  /** Godown staff record receipts too, from the Warehouses page. */
  @Post('purchase-orders/:id/receive')
  @Roles(...GODOWN_ROLES)
  receive(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReceivePurchaseOrderDto, @CurrentUser() user: AuthUser) {
    return this.procurement.receive(id, dto, user);
  }

  @Post('purchase-orders/:id/cancel')
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.procurement.cancel(id, user);
  }

  @Post('purchase-orders/:id/close')
  close(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ClosePurchaseOrderDto, @CurrentUser() user: AuthUser) {
    return this.procurement.close(id, dto.reason, user);
  }
}
