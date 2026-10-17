import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { AuthUser } from '../common/auth-user';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { ADMIN_ROLES, GODOWN_ROLES, GODOWN_VIEW_ROLES } from '../common/roles';
import { DispatchSaleDto, RejectSaleDto, SaleDto } from './dto/sale.dto';
import { SalesService } from './sales.service';
import { deliveryChallanPdf } from './delivery-challan-pdf';

const isoDate = (value?: string) => {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new BadRequestException('Dates must be ISO date-times');
  return parsed;
};

/** Sales are entered by admins; godown staff verify and dispatch them from their warehouse. */
@Controller('sales')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(...ADMIN_ROLES)
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Get() list(@CurrentUser() user: AuthUser) {
    return this.sales.list(user);
  }

  @Get('context') context() {
    return this.sales.context();
  }

  /** Sales waiting for a warehouse to verify and dispatch; shown on its Warehouses page. */
  @Get('outgoing')
  @Roles(...GODOWN_ROLES)
  outgoing(@Query('warehouseId', ParseUUIDPipe) warehouseId: string, @CurrentUser() user: AuthUser) {
    return this.sales.outgoing(warehouseId, user);
  }

  /** What was sold from a warehouse (dispatched sales); `from` / `to` are ISO date-times. Prices only for admins. */
  @Get('dispatched')
  @Roles(...GODOWN_VIEW_ROLES)
  dispatched(@Query('warehouseId', ParseUUIDPipe) warehouseId: string, @CurrentUser() user: AuthUser, @Query('from') from?: string, @Query('to') to?: string) {
    return this.sales.dispatchedFrom(warehouseId, user, isoDate(from), isoDate(to));
  }

  /** Every delivery challan (dispatched sales), newest first; `from` / `to` are ISO date-times. Office (admins) only. */
  @Get('delivery-challans')
  deliveryChallans(@Query('from') from?: string, @Query('to') to?: string) {
    return this.sales.deliveryChallans(isoDate(from), isoDate(to));
  }

  /** The delivery challan of a dispatched sale: an office document, for admins only. */
  @Get(':id/delivery-challan')
  deliveryChallan(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.sales.deliveryChallan(id, user);
  }

  /** The delivery challan as a PDF, to share or print. */
  @Get(':id/delivery-challan/pdf')
  async deliveryChallanPdf(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    const challan = await this.sales.deliveryChallan(id, user);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${challan.challanNo}.pdf"` });
    return new StreamableFile(await deliveryChallanPdf(challan));
  }

  @Get(':id')
  @Roles(...GODOWN_ROLES)
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.sales.findOne(id, user);
  }

  @Post() create(@Body() dto: SaleDto, @CurrentUser() user: AuthUser) {
    return this.sales.create(dto, user);
  }

  @Patch(':id') update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SaleDto, @CurrentUser() user: AuthUser) {
    return this.sales.update(id, dto, user);
  }

  @Post(':id/cancel') cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.sales.cancel(id, user);
  }

  @Post(':id/dispatch')
  @Roles(...GODOWN_ROLES)
  dispatch(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DispatchSaleDto, @CurrentUser() user: AuthUser) {
    return this.sales.dispatch(id, dto, user);
  }

  @Post(':id/reject')
  @Roles(...GODOWN_ROLES)
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectSaleDto, @CurrentUser() user: AuthUser) {
    return this.sales.reject(id, dto, user);
  }
}
