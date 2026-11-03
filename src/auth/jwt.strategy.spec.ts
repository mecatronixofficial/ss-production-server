import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtStrategy } from './jwt.strategy';

describe('Access token session validation', () => {
  const user = { id: 'user', name: 'Current name', email: 'test@example.com', role: 'STAFF', status: 'ACTIVE' };
  const setup = (session: Record<string, unknown> | null) => {
    const db = { refreshSession: { findUnique: jest.fn().mockResolvedValue(session && { user, ...session }) } };
    const strategy = new JwtStrategy(
      new ConfigService({ JWT_ACCESS_SECRET: 'test-access-secret-with-at-least-32-characters' }),
      db as unknown as PrismaService,
    );
    return Object.assign(strategy, { db });
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

  it('rejects an inactive account', async () => {
    await expect(setup({ ...active, user: { ...user, status: 'INACTIVE' } }).validate(payload)).rejects.toThrow('Account is not active');
  });

  it('returns 401 for legacy tokens without a session ID so the client can refresh them', async () => {
    await expect(setup(active).validate({ ...payload, sid: undefined })).rejects.toThrow(UnauthorizedException);
  });

  it('shares one database read between requests that arrive together', async () => {
    const strategy = setup(active);
    await Promise.all([strategy.validate(payload), strategy.validate(payload), strategy.validate(payload)]);
    expect(strategy.db.refreshSession.findUnique).toHaveBeenCalledTimes(1);
  });
});
