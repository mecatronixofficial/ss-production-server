import { PartialType } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

/** No `code` on create: the server assigns the next `TXT-00001`-style code. It can be changed afterwards. */
export class TextileDto {
  @IsString() @IsNotEmpty() @MaxLength(160) name!: string;
  @IsOptional() @IsString() @MaxLength(120) contactPerson?: string | null;
  @IsOptional() @IsString() @MaxLength(30) mobile?: string | null;
  @IsOptional() @IsEmail() @MaxLength(160) email?: string | null;
  @IsOptional() @IsString() @MaxLength(30) gst?: string | null;
  @IsOptional() @IsString() @MaxLength(500) address?: string | null;
  @IsOptional() @IsString() @MaxLength(80) city?: string | null;
  @IsOptional() @IsString() @MaxLength(60) paymentTerms?: string | null;
  /** Most they should owe at a time (informational). */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Credit limit can have at most 2 decimals' })
  @Min(0)
  @Max(1e11)
  creditLimit?: number | null;
  /** What they owed before the ERP; negative for an advance they had already paid. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Opening balance can have at most 2 decimals' })
  @Min(-1e11)
  @Max(1e11)
  openingBalance?: number | null;
  @IsOptional() @IsString() @MaxLength(500) notes?: string | null;
}

export class UpdateTextileDto extends PartialType(TextileDto) {
  @IsOptional()
  @IsString()
  @Matches(/^\s*[A-Za-z0-9][A-Za-z0-9-]{0,29}\s*$/, { message: 'Code can use letters, numbers and dashes (max 30 characters)' })
  code?: string;
  /** Textiles are never deleted; an inactive one can't get new sales. */
  @IsOptional() @IsBoolean() active?: boolean;
}
