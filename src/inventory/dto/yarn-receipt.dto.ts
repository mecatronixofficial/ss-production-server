import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** One count on the mill's DC: bags as written ("30+9"), weight and (admins) the rate. */
export class YarnReceiptLineDto {
  /** An existing line, when correcting a receipt; a new line has none. */
  @IsOptional() @IsUUID() id?: string;
  @Transform(trim) @IsString() @IsNotEmpty({ message: 'Enter the count of every line' }) @MaxLength(120) count!: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(40) @Matches(/^[\d\s+]*$/, { message: 'Write bags as numbers, e.g. 12 or 30+9' }) bags?: string;
  /** As weighed at the godown: what goes into stock. */
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) @Max(9_999_999) weightKg!: number;
  /** As written on the mill's DC, when it differs or to check against. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) @Max(9_999_999) dcWeightKg?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) ratePerKg?: number;
}

/** A yarn delivery as the register keeps it: date, the mill's DC, mill, agent and its counts. */
export class YarnReceiptDto {
  @IsDateString() receivedAt!: string;
  @Transform(trim) @IsString() @IsNotEmpty({ message: 'Enter the DC number' }) @MaxLength(60) dcNo!: string;
  @Transform(trim) @IsString() @IsNotEmpty({ message: 'Enter the mill name' }) @MaxLength(160) millName!: string;
  /** Empty or "Direct" when bought straight from the mill. */
  @IsOptional() @Transform(trim) @IsString() @MaxLength(160) agentName?: string;
  @IsUUID() warehouseId!: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(40) vehicleNo?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) notes?: string;
  @IsArray() @ArrayMinSize(1, { message: 'Add at least one count' }) @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => YarnReceiptLineDto) lines!: YarnReceiptLineDto[];
}
