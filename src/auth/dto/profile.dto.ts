import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class UpdateProfileDto {
  @Transform(trim) @IsString() @IsNotEmpty({ message: 'Name is required' }) @MaxLength(120) name!: string;
}

export class ChangePasswordDto {
  @IsString() @IsNotEmpty({ message: 'Enter your current password' }) @MaxLength(128) currentPassword!: string;
  // Same rule as passwords set by an administrator (users/dto/create-user.dto.ts).
  @IsString() @MinLength(8, { message: 'New password must be at least 8 characters' }) @MaxLength(128) newPassword!: string;
}
