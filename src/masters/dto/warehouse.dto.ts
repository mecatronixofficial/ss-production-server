import { IsBoolean, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/** The code is fixed once created: stock history and receipts show it. */
export class WarehouseDto {
  @IsString()
  @Matches(/^\s*[A-Za-z0-9][A-Za-z0-9-]{0,29}\s*$/, { message: 'Code can use letters, numbers and dashes (max 30 characters)' })
  code!: string;
  @IsString() @IsNotEmpty() @MaxLength(80) name!: string;
  @IsOptional() @IsString() @MaxLength(120) location?: string | null;
}

export class UpdateWarehouseDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(120) location?: string | null;
  /** An inactive warehouse can't take new receipts or godown entries. */
  @IsOptional() @IsBoolean() active?: boolean;
}
