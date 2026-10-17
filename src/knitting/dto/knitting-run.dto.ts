import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { KnittingShift } from '@prisma/client';

/** One yarn loaded on a run, taken from stock by item code. */
export class RunYarnDto {
  @IsString() @IsNotEmpty() @MaxLength(80) itemCode!: string;
  @IsUUID() warehouseId!: string;
  @IsOptional() @IsString() @MaxLength(80) lotNo?: string;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) kg!: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) ratePerKg!: number;
}

/** Loading a machine: one to three yarns (together no more than the machine's capacity). */
export class StartRunDto {
  /** Existing own-mill Production task. Its allocated yarn is already out of stock. */
  @IsOptional() @IsUUID() productionFlowId?: string;
  /** KG from the production task loaded in this machine round. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) productionYarnKg?: number;
  @IsUUID() machineId!: string;
  @IsDateString() startDate!: string;
  @IsEnum(KnittingShift) startShift!: KnittingShift;
  @IsOptional() @IsUUID() operatorId?: string;
  @IsOptional() @IsString() @MaxLength(120) fabricType?: string;
  /** Knitting charge per KG of fabric; the machine's own rate when left out. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) ratePerKg?: number;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => RunYarnDto)
  yarns?: RunYarnDto[];
}

/** Taking the fabric off: its weight goes into a warehouse as grey fabric under the run's code. */
export class FinishRunDto {
  @IsDateString() finishDate!: string;
  @IsEnum(KnittingShift) finishShift!: KnittingShift;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) outputKg!: number;
  @IsOptional() @IsInt() @Min(0) rollCount?: number;
  @IsUUID() warehouseId!: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) ratePerKg!: number;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}
