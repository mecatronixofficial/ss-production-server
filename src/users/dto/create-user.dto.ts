import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { Role, UserStatus } from '@prisma/client';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateUserDto {
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
  @Transform(trim) @IsEmail() email!: string;
  @IsString() @MinLength(8) @MaxLength(128) password!: string;
  @IsEnum(Role) role!: Role;
  @IsOptional() @IsUUID() employeeId?: string;
}

export class UpdateUserDto {
  @IsOptional() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(120) name?: string;
  @IsOptional() @IsEnum(Role) role?: Role;
  @IsOptional() @IsEnum(UserStatus) status?: UserStatus;
  @IsOptional() @IsString() @MinLength(8) @MaxLength(128) password?: string;
  /** `null` unlinks the employee. */
  @IsOptional() @IsUUID() employeeId?: string | null;
}
