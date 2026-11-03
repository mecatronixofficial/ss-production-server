import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { StockCategory } from '@prisma/client';
import { PACKAGES_PATTERN } from '../../common/packages';

/** No item code: each line gets its own SS-<year>-<n> code when it is first received. */
/** One detail of a purchase line, e.g. { label: 'Count', value: "36'S" }. */
export class PurchaseItemSpecDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  label!: string;

  @IsString()
  @MaxLength(120)
  value!: string;
}

export class PurchaseOrderItemDto {
  @IsString()
  @IsNotEmpty()
  itemName!: string;

  /** Its details by material (yarn count, quality, blend, mill, bags…; fabric type, dia, GSM, colour…). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => PurchaseItemSpecDto)
  specs?: PurchaseItemSpecDto[];

  /** The stock the line becomes when received. */
  @IsEnum(StockCategory)
  category!: StockCategory;

  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  quantity!: number;

  @IsString()
  @IsNotEmpty()
  unit!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  rate!: number;
}

export class CreatePurchaseOrderDto {
  @IsString()
  @IsNotEmpty()
  supplierId!: string;

  /** The warehouse the material is delivered to; its page shows the PO as waiting to be received. */
  @IsUUID()
  warehouseId!: string;

  @IsOptional()
  @IsDateString()
  expectedDate?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderItemDto)
  items!: PurchaseOrderItemDto[];
}

export class ClosePurchaseOrderDto {
  /** Why the rest won't come, e.g. "Distributor out of stock". Kept in the audit log. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

/** One ordered detail as checked at receipt: it matched, or what came instead. */
export class ReceiptDetailCheckDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  label!: string;

  @IsString()
  @MaxLength(120)
  ordered!: string;

  @IsBoolean()
  ok!: boolean;

  /** What came, when it differs from what was ordered. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  received?: string;
}

export class PurchaseReceiptItemDto {
  @IsUUID()
  purchaseOrderItemId!: string;

  /** What arrived, as weighed / counted at the godown. */
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  quantity!: number;

  /** The quantity written on the distributor's DC, to check against. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  dcQuantity?: number;

  /** Bags / rolls as written, e.g. 12 or 30+9. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Matches(PACKAGES_PATTERN, { message: 'Write bags / rolls as numbers, e.g. 12 or 30+9' })
  packages?: string;

  /** The count, shade or anything noted for the line. */
  @IsOptional()
  @IsString()
  @MaxLength(160)
  details?: string;

  /** Each detail ordered, checked against what came. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ReceiptDetailCheckDto)
  checks?: ReceiptDetailCheckDto[];
}

export class ReceivePurchaseOrderDto {
  @IsUUID()
  warehouseId!: string;

  /** Only for lines ordered without a category (older POs); other lines are received as the category they were ordered as. */
  @IsOptional()
  @IsEnum(StockCategory)
  category?: StockCategory;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  lotNo?: string;

  /** The distributor's delivery challan / invoice number that came with the material. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  challanNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  vehicleNo?: string;

  /** Remarks at receipt, e.g. "2 bags torn". */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseReceiptItemDto)
  items!: PurchaseReceiptItemDto[];
}
