import 'reflect-metadata';
import { validateEnv } from './env.validation';

describe('Environment validation', () => {
  const validConfig = {
    DATABASE_URL: 'postgresql://localhost/erp',
    JWT_ACCESS_SECRET: 'test-access-secret-with-at-least-32-characters',
    JWT_REFRESH_SECRET: 'test-refresh-secret-with-at-least-32-characters',
  };

  it('accepts the empty optional Swagger setting documented in .env.example', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgresql://localhost/erp',
        JWT_ACCESS_SECRET: 'test-access-secret-with-at-least-32-characters',
        JWT_REFRESH_SECRET: 'test-refresh-secret-with-at-least-32-characters',
        SWAGGER_ENABLED: '',
      }),
    ).not.toThrow();
  });

  it.each(['postgresql://localhost/erp', 'postgres://localhost/erp'])('accepts the PostgreSQL protocol: %s', (DATABASE_URL) => {
    expect(() => validateEnv({ ...validConfig, DATABASE_URL })).not.toThrow();
  });

  it.each(['mysql://localhost/erp', 'https://localhost/erp', 'postgresql:localhost/erp'])(
    'rejects an incompatible database URL: %s',
    (DATABASE_URL) => {
      expect(() => validateEnv({ ...validConfig, DATABASE_URL })).toThrow('DATABASE_URL must start with postgresql:// or postgres://');
    },
  );

  it('does not include connection credentials in the validation error', () => {
    const DATABASE_URL = 'mysql://private-user:private-password@private-host:3306/erp';
    try {
      validateEnv({ ...validConfig, DATABASE_URL });
      throw new Error('Expected the MySQL URL to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('DATABASE_URL must start with postgresql:// or postgres://');
      expect((error as Error).message).not.toContain('private-');
      expect((error as Error).message).not.toContain(DATABASE_URL);
    }
  });
});
