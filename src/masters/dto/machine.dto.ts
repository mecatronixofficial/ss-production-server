import { PartialType } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { MachineStatus } from '@prisma/client';

export class MachineDto {
  @IsString() @IsNotEmpty() code!: string;
  @IsString() @IsNotEmpty() name!: string;
  /** Machines are knitting machines; Knitting when left out. */
  @IsOptional() @IsString() @IsNotEmpty() department?: string;
  @IsOptional() @IsString() type?: string;
  /** Yarn one load takes; 240 KG when left out. */
  @IsOptional() @IsNumber() @Min(0.001) capacityKg?: number;
  /** Knitting charge per KG of fabric. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) ratePerKg?: number;
  @IsOptional() @IsString() manufacturer?: string;
  @IsOptional() @IsEnum(MachineStatus) status?: MachineStatus;
}

export class UpdateMachineDto extends PartialType(MachineDto) {}
