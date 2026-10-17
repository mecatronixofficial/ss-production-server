import { Transform } from 'class-transformer';
import { IsDateString, IsEnum, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { StockCategory, StockTxnType } from '@prisma/client';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** The godown only holds yarn and fabric. */
export const GODOWN_CATEGORIES: StockCategory[] = ['YARN', 'GREY_FABRIC', 'DYED_FABRIC', 'FINISHED_FABRIC'];

/** Reasons a manual entry may give, by direction. */
export const ENTRY_TYPES = {
  IN: ['OPENING', 'PURCHASE_IN', 'RETURN_IN', 'ADJUSTMENT'],
  OUT: ['PRODUCTION_ISSUE', 'DISPATCH_OUT', 'WASTE', 'ADJUSTMENT'],
} satisfies Record<string, StockTxnType[]>;

export type EntryDirection = keyof typeof ENTRY_TYPES;

/** Create or replace a manual godown entry. */
export class GodownEntryDto {
  @IsIn(['IN', 'OUT']) direction!: EntryDirection;
  @IsIn(GODOWN_CATEGORIES) category!: StockCategory;
  /** One of ENTRY_TYPES for the direction; an edit may also keep the movement's original type. */
  @IsEnum(StockTxnType) txnType!: StockTxnType;
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(120) itemName!: string;
  /** Omit to reuse the code of an existing item with the same name, or derive one from the name. */
  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) itemCode?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(60) lotNo?: string;
  @IsUUID() warehouseId!: string;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) @Max(99_999_999) quantityKg!: number;
  /** Backdates the movement; defaults to now. */
  @IsOptional() @IsDateString() entryDate?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) notes?: string;
}
