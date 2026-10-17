import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { SalePartyType, StockCategory } from '@prisma/client';

/** GST rates a sale's bill can carry. */
export const GST_RATES = [0, 5, 12, 18] as const;

/** One stock position (item, lot, unit) in the sale's warehouse. */
export class SaleItemDto {
  @IsEnum(StockCategory) category!: StockCategory;
  @IsString() @IsNotEmpty() @MaxLength(80) itemCode!: string;
  @IsString() @IsNotEmpty() @MaxLength(160) itemName!: string;
  @IsOptional() @IsString() @MaxLength(80) lotNo?: string;
  @IsString() @IsNotEmpty() @MaxLength(20) unit!: string;
  @IsNumber({ maxDecimalPlaces: 3 }, { message: 'Quantity can have at most 3 decimals' }) @Min(0.001) quantity!: number;
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Rate can have at most 2 decimals' }) @Min(0) rate!: number;
}

/** Vehicle the material leaves on; all optional, and the warehouse can correct them on dispatch. */
class VehicleFields {
  @IsOptional() @IsString() @MaxLength(30) vehicleNo?: string;
  @IsOptional() @IsString() @MaxLength(80) driverName?: string;
  @IsOptional() @IsString() @MaxLength(30) driverPhone?: string;
  @IsOptional() @IsString() @MaxLength(120) transporter?: string;
  @IsOptional() @IsString() @MaxLength(60) lrNo?: string;
}

export class SaleDto extends VehicleFields {
  @IsDateString() saleDate!: string;
  @IsEnum(SalePartyType) partyType!: SalePartyType;
  /** The distributor, when sold to one. */
  @ValidateIf((d: SaleDto) => d.partyType === SalePartyType.DISTRIBUTOR)
  @IsUUID(undefined, { message: 'Choose the distributor' })
  supplierId?: string;
  /** The textile from the Textiles list, when sold to a textile. */
  @IsOptional() @IsUUID(undefined, { message: 'Choose the textile' }) textileId?: string;
  /** Or a textile's name: one not on the Textiles list yet is added to it with the details below. */
  @ValidateIf((d: SaleDto) => d.partyType === SalePartyType.TEXTILE && !d.textileId)
  @IsString()
  @IsNotEmpty({ message: 'Choose the textile or enter its name' })
  @MaxLength(160)
  partyName?: string;
  @IsOptional() @IsString() @MaxLength(30) partyGst?: string;
  @IsOptional() @IsString() @MaxLength(30) partyPhone?: string;
  @IsOptional() @IsString() @MaxLength(500) partyAddress?: string;
  @IsUUID(undefined, { message: 'Choose the warehouse the material leaves from' }) warehouseId!: string;
  @IsIn(GST_RATES, { message: 'GST must be 0, 5, 12 or 18%' }) gstRate!: number;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsArray()
  @ArrayMinSize(1, { message: 'Add at least one item' })
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SaleItemDto)
  items!: SaleItemDto[];
}

export class DispatchLineDto {
  @IsUUID() id!: string;
  /** What actually went on the vehicle (up to what was sold; 0 leaves a line out). */
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) quantity!: number;
}

/** The warehouse's verification: what was loaded, the vehicle as it left, and any remarks. */
export class DispatchSaleDto extends VehicleFields {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => DispatchLineDto)
  items!: DispatchLineDto[];
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class RejectSaleDto {
  @IsString() @IsNotEmpty({ message: 'Say what is wrong' }) @MaxLength(500) reason!: string;
}
