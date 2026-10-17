import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, IsTimeZone, IsUrl, Matches, MaxLength } from 'class-validator';

export const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED'] as const;

/** Trims strings and turns blank optional fields into "not set". */
const clean = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || undefined : value);
const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() || undefined : value);

export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/** Stored as the `company` SystemSetting. */
export class CompanyProfileDto {
  @Transform(clean) @IsString() @IsNotEmpty({ message: 'Company name is required' }) @MaxLength(120) name!: string;
  @Transform(clean) @IsOptional() @IsString() @MaxLength(160) legalName?: string;

  @Transform(upper) @IsOptional() @Matches(GSTIN_PATTERN, { message: 'GSTIN must be a valid 15-character GST number' }) gst?: string;
  @Transform(upper) @IsOptional() @Matches(PAN_PATTERN, { message: 'PAN must look like ABCDE1234F' }) pan?: string;

  @Transform(clean) @IsOptional() @IsEmail({}, { message: 'Enter a valid email address' }) @MaxLength(254) email?: string;
  @Transform(clean)
  @IsOptional()
  @Matches(/^\+?[0-9][0-9 ()-]{6,19}$/, { message: 'Enter a valid phone number' })
  phone?: string;
  @Transform(clean)
  @IsOptional()
  @IsUrl({ require_protocol: false }, { message: 'Enter a valid website address' })
  @MaxLength(200)
  website?: string;

  @Transform(clean) @IsOptional() @IsString() @MaxLength(300) address?: string;
  @Transform(clean) @IsOptional() @IsString() @MaxLength(80) city?: string;
  @Transform(clean) @IsOptional() @IsString() @MaxLength(80) state?: string;
  @Transform(clean) @IsOptional() @Matches(/^[1-9][0-9]{5}$/, { message: 'PIN code must be 6 digits' }) pincode?: string;

  @IsIn(CURRENCIES, { message: `Currency must be one of ${CURRENCIES.join(', ')}` }) currency!: string;
  @IsTimeZone({ message: 'Choose a valid time zone' }) timezone!: string;
}
