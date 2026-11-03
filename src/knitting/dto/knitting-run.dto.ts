import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { KnittingShift } from '@prisma/client';

/** One machine a task is put on, with who runs it and its knitting charge (the machine's own when left out). */
export class AssignMachineDto {
  @IsUUID() machineId!: string;
  @IsOptional() @IsUUID() operatorId?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) ratePerKg?: number;
}

/** Putting a Production knitting task on one or more machines. No KG is fixed per machine: each knits from the task's yarn. */
export class AssignMachinesDto {
  @IsDateString() startDate!: string;
  @IsEnum(KnittingShift) startShift!: KnittingShift;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AssignMachineDto)
  machines!: AssignMachineDto[];
}

/** Putting a task on a single machine (the older form of `AssignMachinesDto`). */
export class StartRunDto {
  @IsUUID() productionFlowId!: string;
  @IsUUID() machineId!: string;
  @IsDateString() startDate!: string;
  @IsEnum(KnittingShift) startShift!: KnittingShift;
  @IsOptional() @IsUUID() operatorId?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) ratePerKg?: number;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

/** One machine's production for the day: fabric KG and rolls. 0 KG records a day it stood still. */
export class DayLineDto {
  @IsUUID() runId!: string;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) outputKg!: number;
  @IsInt() @Min(0) rollCount!: number;
  /** The yarn the machine used that day; the fabric's weight is taken when left out. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) yarnUsedKg?: number;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

/** The day-end entry: what each machine knitted on one production day, into one warehouse. Recording a day again replaces it. */
export class DayEntriesDto {
  @IsDateString() date!: string;
  @IsUUID() warehouseId!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => DayLineDto)
  entries!: DayLineDto[];
}

/** Stopping a machine: optionally the last day's production, then the run is closed. */
export class FinishRunDto {
  @IsDateString() finishDate!: string;
  @IsEnum(KnittingShift) finishShift!: KnittingShift;
  /** The finish day's production, recorded (or replaced) with the finish. Leave out when the day is already recorded. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) outputKg?: number;
  @IsOptional() @IsInt() @Min(0) rollCount?: number;
  @IsOptional() @IsUUID() warehouseId?: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) ratePerKg!: number;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  /** When this was the task's last running machine: whether the task's knitting is complete. */
  @IsOptional() @IsBoolean() completeTask?: boolean;
  /** With `completeTask`: the yarn the whole task used; the rest of the yarn given goes back to its warehouse. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) yarnUsedKg?: number;
}

/** Moving a run to another machine (the first one broke down or needs repair). */
export class MoveRunDto {
  @IsUUID() machineId!: string;
  @IsDateString() date!: string;
  @IsEnum(KnittingShift) shift!: KnittingShift;
  /** What the first machine is set to. */
  @IsIn(['BREAKDOWN', 'MAINTENANCE', 'IDLE']) machineStatus!: 'BREAKDOWN' | 'MAINTENANCE' | 'IDLE';
  /** The first machine's production on the day of the change, before it stopped. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) outputKg?: number;
  @IsOptional() @IsInt() @Min(0) rollCount?: number;
  @IsOptional() @IsUUID() warehouseId?: string;
  /** Who runs the new machine; the same operator when left out. */
  @IsOptional() @IsUUID() operatorId?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

/** Marking a task's knitting complete (no machine on it), or open again. */
export class CompleteTaskDto {
  @IsBoolean() complete!: boolean;
  /** Completing: the yarn the task used; the rest of the yarn given goes back to its warehouse. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) yarnUsedKg?: number;
}
