import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { StockCategory } from '@prisma/client';

/** No item code: each line gets its own SS-<year>-<n> code when it is first received. */
export class PurchaseOrderItemDto {
  @IsString()
  @IsNotEmpty()
  itemName!: string;

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

export class PurchaseReceiptItemDto {
  @IsUUID()
  purchaseOrderItemId!: string;

  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  quantity!: number;
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
