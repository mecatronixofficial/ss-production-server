import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import { AuthUser } from '../common/auth-user';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { GODOWN_ROLES, GODOWN_VIEW_ROLES, MACHINE_ROLES } from '../common/roles';
import { ProductionService } from './production.service';
import {
  CreateFabricExpenseDto,
  FinishKnittingDto,
  KnittingDetailsDto,
  ReceiveFabricDto,
  RecordDeliveryDto,
  StartCompactingDto,
  StartDyeingDto,
  StartKnittingDto,
  StartStockProcessDto,
  UpdateFabricCompactingDto,
  UpdateFabricDyeingDto,
} from './dto/fabric-flow.dto';

@Controller('production')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(Role.SUPERADMIN, Role.ADMIN)
export class ProductionController {
  constructor(private service: ProductionService) {}

  @Get('fabric-flows')
  @Roles(...MACHINE_ROLES)
  fabricFlows(@CurrentUser() user: AuthUser) {
    return this.service.fabricFlows(user);
  }

  @Get('fabric-flows/directory')
  @Roles(...MACHINE_ROLES)
  fabricFlowDirectory() {
    return this.service.fabricFlowDirectory();
  }

  /** Starts a batch from yarn in a warehouse (taken out of stock) and begins knitting it. */
  @Post('fabric-flows/start-knitting')
  startKnitting(@Body() dto: StartKnittingDto, @CurrentUser() user: AuthUser) {
    return this.service.startKnitting(dto, user);
  }

  @Post('fabric-flows/start-stock-process')
  startStockProcess(@Body() dto: StartStockProcessDto, @CurrentUser() user: AuthUser) {
    return this.service.startStockProcess(dto, user);
  }

  @Patch('fabric-flows/:id/knitting')
  updateKnitting(@Param('id', ParseUUIDPipe) id: string, @Body() dto: KnittingDetailsDto) {
    return this.service.updateKnitting(id, dto);
  }

  @Post('fabric-flows/:id/knitting/finish')
  @Roles(...MACHINE_ROLES)
  finishKnitting(@Param('id', ParseUUIDPipe) id: string, @Body() dto: FinishKnittingDto, @CurrentUser() user: AuthUser) {
    return this.service.finishKnitting(id, dto, user);
  }

  /** Dyeing started at a party / mill; completed later with POST …/dyeing. */
  @Post('fabric-flows/:id/dyeing/start')
  startDyeing(@Param('id', ParseUUIDPipe) id: string, @Body() dto: StartDyeingDto) {
    return this.service.startDyeing(id, dto);
  }

  /** Compacting started at a party / mill; completed later with POST …/compacting. */
  @Post('fabric-flows/:id/compacting/start')
  startCompacting(@Param('id', ParseUUIDPipe) id: string, @Body() dto: StartCompactingDto) {
    return this.service.startCompacting(id, dto);
  }

  @Post('fabric-flows/:id/dyeing')
  updateFabricDyeing(@Param('id') id: string, @Body() dto: UpdateFabricDyeingDto) {
    return this.service.updateFabricDyeing(id, dto);
  }

  @Post('fabric-flows/:id/compacting')
  updateFabricCompacting(@Param('id') id: string, @Body() dto: UpdateFabricCompactingDto) {
    return this.service.updateFabricCompacting(id, dto);
  }

  /** Finished fabric to a party or into a warehouse (as stock under the batch code). */
  @Post('fabric-flows/:id/deliveries')
  recordDelivery(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RecordDeliveryDto, @CurrentUser() user: AuthUser) {
    return this.service.recordDelivery(id, dto, user);
  }

  /** Fabric from production on its way to a warehouse; shown on its Warehouses page, where staff receive it. */
  @Get('incoming-fabric')
  @Roles(...GODOWN_VIEW_ROLES)
  incomingFabric(@Query('warehouseId', ParseUUIDPipe) warehouseId: string) {
    return this.service.incomingFabric(warehouseId);
  }

  @Post('deliveries/:deliveryId/receive')
  @Roles(...GODOWN_ROLES)
  receiveFabric(@Param('deliveryId', ParseUUIDPipe) deliveryId: string, @Body() dto: ReceiveFabricDto, @CurrentUser() user: AuthUser) {
    return this.service.receiveFabric(deliveryId, dto, user);
  }

  @Delete('fabric-flows/:id/deliveries/:deliveryId')
  deleteDelivery(@Param('id', ParseUUIDPipe) id: string, @Param('deliveryId', ParseUUIDPipe) deliveryId: string, @CurrentUser() user: AuthUser) {
    return this.service.deleteDelivery(id, deliveryId, user);
  }

  @Post('fabric-flows/:id/expenses')
  addExpense(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateFabricExpenseDto, @CurrentUser() user: AuthUser) {
    return this.service.addExpense(id, dto, user);
  }

  @Delete('fabric-flows/:id/expenses/:expenseId')
  deleteExpense(@Param('id', ParseUUIDPipe) id: string, @Param('expenseId', ParseUUIDPipe) expenseId: string, @CurrentUser() user: AuthUser) {
    return this.service.deleteExpense(id, expenseId, user);
  }

  /** A document or photo for one process of the batch (multipart: `file`, `stage`). Images, PDF or spreadsheets, up to 10 MB. */
  @Post('fabric-flows/:id/attachments')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024, files: 1 } }))
  addAttachment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('stage') stage: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.addAttachment(id, stage, file, user);
  }

  /** Serves the file to signed-in admins only; storage is never exposed directly. */
  @Get('fabric-flows/:id/attachments/:attachmentId')
  @Roles(...MACHINE_ROLES)
  async attachmentFile(@Param('id', ParseUUIDPipe) id: string, @Param('attachmentId', ParseUUIDPipe) attachmentId: string) {
    const { attachment, body } = await this.service.attachmentFile(id, attachmentId);
    return new StreamableFile(body, {
      type: attachment.mimeType,
      disposition: `inline; filename="${attachment.fileName.replace(/["\\\r\n]/g, '_')}"`,
      length: body.length,
    });
  }

  @Delete('fabric-flows/:id/attachments/:attachmentId')
  deleteAttachment(@Param('id', ParseUUIDPipe) id: string, @Param('attachmentId', ParseUUIDPipe) attachmentId: string) {
    return this.service.deleteAttachment(id, attachmentId);
  }
}
