import { plainToInstance } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, Min, MinLength, ValidateIf, validateSync } from 'class-validator';

class EnvironmentVariables {
  @IsOptional() @IsIn(['development', 'production', 'test']) NODE_ENV?: string;
  @IsOptional() @IsInt() @Min(1) @Max(65535) PORT?: number;
  @IsString() @IsNotEmpty() DATABASE_URL!: string;
  @IsString() @MinLength(32, { message: 'JWT_ACCESS_SECRET must be at least 32 characters' }) JWT_ACCESS_SECRET!: string;
  @IsString() @MinLength(32, { message: 'JWT_REFRESH_SECRET must be at least 32 characters' }) JWT_REFRESH_SECRET!: string;
  @IsOptional() @IsString() ACCESS_TOKEN_EXPIRES?: string;
  @IsOptional() @IsString() REFRESH_TOKEN_EXPIRES?: string;
  @IsOptional() @IsString() FRONTEND_URL?: string;
  @IsOptional() @IsString() TRUST_PROXY?: string;
  @IsOptional() @IsIn(['true', 'false']) SWAGGER_ENABLED?: string;
  /** Encrypts bank account numbers at rest (src/common/crypto.ts). Needed only to save an account number. */
  @ValidateIf((env: EnvironmentVariables) => !!env.DATA_ENCRYPTION_KEY)
  @Matches(/^[0-9a-fA-F]{64}$/, { message: 'DATA_ENCRYPTION_KEY must be 64 hex characters (32 bytes)' })
  DATA_ENCRYPTION_KEY?: string;
}

export function validateEnv(config: Record<string, unknown>) {
  const env = plainToInstance(EnvironmentVariables, config, { enableImplicitConversion: true });
  const errors = validateSync(env, { skipMissingProperties: false, whitelist: false });
  const messages = errors.flatMap((error) => Object.values(error.constraints ?? {}));
  if (config.JWT_ACCESS_SECRET && config.JWT_ACCESS_SECRET === config.JWT_REFRESH_SECRET) {
    messages.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different');
  }
  if (messages.length) throw new Error(`Invalid environment configuration:\n - ${messages.join('\n - ')}`);
  // Return the raw config so string values (e.g. DATABASE_URL) are not coerced.
  return config;
}
