import { PartialType } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

/** No `code` on create: the server assigns the next `DST-00001`-style distributor code. It can be changed afterwards. */
export class SupplierDto {
  @IsString() @IsNotEmpty() @MaxLength(160) name!: string;
  @IsOptional() @IsString() @MaxLength(160) company?: string | null;
  @IsOptional() @IsString() @MaxLength(120) contactPerson?: string | null;
  @IsOptional() @IsString() @MaxLength(30) mobile?: string | null;
  @IsOptional() @IsEmail() @MaxLength(160) email?: string | null;
  @IsOptional() @IsString() @MaxLength(30) gst?: string | null;
  @IsOptional() @IsString() @MaxLength(500) address?: string | null;
  @IsOptional() @IsString() @MaxLength(60) materialCategory?: string | null;
  @IsOptional() @IsString() @MaxLength(60) paymentTerms?: string | null;
  /** Amount payable to the supplier before the first purchase in the ERP; negative for an advance already paid. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Opening balance can have at most 2 decimals' })
  @Min(-1e11)
  @Max(1e11)
  openingBalance?: number | null;
}

export class UpdateSupplierDto extends PartialType(SupplierDto) {
  @IsOptional()
  @IsString()
  @Matches(/^\s*[A-Za-z0-9][A-Za-z0-9-]{0,29}\s*$/, { message: 'Code can use letters, numbers and dashes (max 30 characters)' })
  code?: string;
  /** Suppliers are never deleted; an inactive one can't be picked for new purchase orders. */
  @IsOptional() @IsBoolean() active?: boolean;
}
