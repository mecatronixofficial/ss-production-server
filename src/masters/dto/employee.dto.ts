import { PartialType } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

// Keep in sync with SHIFTS in frontend/app/(erp)/masters/employees/page.tsx.
const SHIFTS = ['A', 'B', 'C', 'General'] as const;

export class EmployeeDto {
  @IsString()
  @Matches(/^\s*[A-Za-z0-9][A-Za-z0-9-]{0,29}\s*$/, { message: 'Code can use letters, numbers and dashes (max 30 characters)' })
  code!: string;
  @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
  @IsString() @IsNotEmpty() @MaxLength(60) department!: string;
  @IsOptional() @IsString() @MaxLength(30) mobile?: string | null;
  @IsOptional() @IsIn(SHIFTS) shift?: string | null;
  /** Calendar date, e.g. 2026-10-07. */
  @IsOptional() @IsDateString() joiningDate?: string | null;
}

export class UpdateEmployeeDto extends PartialType(EmployeeDto) {
  /** Employees are never deleted; an inactive one can't be picked as a machine operator. */
  @IsOptional() @IsBoolean() active?: boolean;
}
