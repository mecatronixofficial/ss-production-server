import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtStrategy } from './jwt.strategy';

describe('Access token session validation', () => {
  const setup = (session: Record<string, unknown> | null) => {
    const db = {
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'user', name: 'Current name', email: 'test@example.com', role: 'STAFF', status: 'ACTIVE' }),
      },
      refreshSession: { findUnique: jest.fn().mockResolvedValue(session) },
    };
    return new JwtStrategy(
      new ConfigService({ JWT_ACCESS_SECRET: 'test-access-secret-with-at-least-32-characters' }),
      db as unknown as PrismaService,
    );
  };
  const payload = { sub: 'user', sid: 'session', name: 'Old name', email: 'test@example.com', role: 'ADMIN' as const };
  const active = { userId: 'user', revokedAt: null, expiresAt: new Date(Date.now() + 60000) };

  it('uses the current database role for an active session', async () => {
    await expect(setup(active).validate(payload)).resolves.toMatchObject({ name: 'Current name', role: 'STAFF' });
  });

  it.each([null, { ...active, revokedAt: new Date() }, { ...active, expiresAt: new Date(0) }, { ...active, userId: 'another-user' }])(
    'rejects a missing, revoked, expired or mismatched session',
    async (session) => {
      await expect(setup(session).validate(payload)).rejects.toThrow(UnauthorizedException);
    },
  );

  it('returns 401 for legacy tokens without a session ID so the client can refresh them', async () => {
    await expect(setup(active).validate({ ...payload, sid: undefined })).rejects.toThrow(UnauthorizedException);
  });
});
