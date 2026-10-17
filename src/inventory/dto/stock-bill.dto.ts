import { StockBillKind } from '@prisma/client';
import { IsDateString, IsEnum, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/** Issue the received / export bill for one source's stock movements in a warehouse. */
export class CreateStockBillDto {
  @IsUUID() warehouseId!: string;
  @IsString() @IsNotEmpty() @MaxLength(40) referenceType!: string;
  @IsString() @IsNotEmpty() @MaxLength(80) referenceId!: string;
  @IsEnum(StockBillKind) kind!: StockBillKind;
  /** Who it came from / went to, if not taken from the source. */
  @IsOptional() @IsString() @MaxLength(160) partyName?: string;
  @IsOptional() @IsString() @MaxLength(30) vehicleNo?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

/** Clear a warehouse's old movements without a bill (made up to `before`, default now) as needing none. */
export class ClearUnbilledDto {
  @IsUUID() warehouseId!: string;
  @IsOptional() @IsDateString() before?: string;
}

export class CancelStockBillDto {
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

/** Issue challans for every movement still waiting for one: in one warehouse, or all when left out. */
export class IssueAllStockBillsDto {
  @IsOptional() @IsUUID() warehouseId?: string;
}
