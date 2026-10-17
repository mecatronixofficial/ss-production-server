import { PartialType } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

// Keep in sync with serviceOptions in frontend/app/(erp)/masters/mills/page.tsx.
const SERVICES = ['KNITTING', 'DYEING', 'COMPACTING', 'KNITTING,DYEING', 'KNITTING,COMPACTING', 'DYEING,COMPACTING', 'KNITTING,DYEING,COMPACTING'] as const;

export class MillDto {
  @IsString() @Matches(/^PC-[A-Za-z0-9-]{1,20}$/, { message: 'Code must start with PC-' }) code!: string;
  @IsString() @IsNotEmpty() @MaxLength(160) name!: string;
  @IsString() @IsIn(SERVICES) services!: string;
  @IsOptional() @IsString() @MaxLength(120) contactPerson?: string;
  @IsOptional() @IsString() @MaxLength(30) mobile?: string;
  @IsOptional() @IsString() @MaxLength(30) alternateMobile?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(30) gst?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsString() @MaxLength(100) city?: string;
  @IsOptional() @IsString() @MaxLength(100) state?: string;
  @IsOptional() @IsString() @MaxLength(100) paymentTerms?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class UpdateMillDto extends PartialType(MillDto) {
  @IsOptional() @IsBoolean() active?: boolean;
}
