import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'crypto';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';

describe('Refresh session termination', () => {
  const setup = () => {
    const jwt = new JwtService();
    const now = new Date();
    const rows = [
      { id: 'active', userId: 'user', revokedAt: null as Date | null, expiresAt: new Date(now.getTime() + 60000) },
      { id: 'rotated', userId: 'user', revokedAt: now, expiresAt: new Date(now.getTime() + 60000) },
    ];
    const updateMany = jest.fn(({ where, data }: { where: any; data: any }) => {
      const selected = rows.filter(
        (row) =>
          row.userId === where.userId &&
          (!('revokedAt' in where) || row.revokedAt === where.revokedAt) &&
          (!where.expiresAt?.gt || row.expiresAt > where.expiresAt.gt) &&
          (!where.id?.not || row.id !== where.id.not),
      );
      selected.forEach((row) => Object.assign(row, data));
      return Promise.resolve({ count: selected.length });
    });
    const db = {
      refreshSession: { updateMany },
      $executeRaw: jest.fn().mockResolvedValue(1),
      $transaction: <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
    };
    const config = new ConfigService({ JWT_REFRESH_SECRET: 'test-refresh-secret-that-is-at-least-32-characters' });
    return { service: new AuthService(db as unknown as PrismaService, jwt, config), rows, updateMany, jwt, config };
  };

  it('does not let an unsigned or wrongly signed cookie revoke a session', async () => {
    const { service, jwt, updateMany } = setup();
    const forged = jwt.sign({ sid: 'active', sub: 'user' }, { secret: 'wrong-signing-key' });
    await service.revoke(forged);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('revokes a genuine refresh token with its user and token hash', async () => {
    const { service, jwt, config, updateMany } = setup();
    const token = jwt.sign({ sid: 'active', sub: 'user' }, { secret: config.getOrThrow<string>('JWT_REFRESH_SECRET') });
    await service.revoke(token);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'active', userId: 'user', tokenHash: createHash('sha256').update(token).digest('hex') }),
      }),
    );
  });

  it('also expires recently rotated tokens when signing out everywhere', async () => {
    const { service, rows } = setup();
    await service.revokeAll('user');
    expect(rows.every((row) => row.expiresAt <= new Date())).toBe(true);
  });

  it('expires rotated tokens when signing out other devices', async () => {
    const { service, rows } = setup();
    await service.revokeOtherSessions('user', 'active');
    expect(rows[0].expiresAt > new Date()).toBe(true);
    expect(rows[1].expiresAt <= new Date()).toBe(true);
  });
});

describe('Refresh rotation and sign-out transactions', () => {
  const setup = () => {
    const jwt = new JwtService();
    const config = new ConfigService({
      JWT_ACCESS_SECRET: 'isolated-access-secret-with-at-least-32-characters',
      JWT_REFRESH_SECRET: 'isolated-refresh-secret-with-at-least-32-characters',
    });
    const user = { id: 'user', name: 'Test', email: 'test@example.com', role: 'ADMIN' as const, status: 'ACTIVE' };
    let rows: Array<{ id: string; userId: string; tokenHash: string; revokedAt: Date | null; expiresAt: Date }> = [];
    let tail: Promise<unknown> = Promise.resolve();
    const db = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      refreshSession: {
        create: jest.fn(({ data }: { data: Omit<(typeof rows)[number], 'revokedAt'> }) => {
          rows.push({ ...data, revokedAt: null });
          return Promise.resolve(data);
        }),
        findUnique: jest.fn(({ where }: { where: { id: string } }) => {
          const row = rows.find((r) => r.id === where.id);
          return Promise.resolve(row ? { ...row, user } : null);
        }),
        updateMany: jest.fn(({ where, data }: { where: any; data: any }) => {
          const selected = rows.filter(
            (row) =>
              (!where.userId || row.userId === where.userId) &&
              (typeof where.id !== 'string' || row.id === where.id) &&
              (!where.id?.not || row.id !== where.id.not) &&
              (!where.tokenHash || row.tokenHash === where.tokenHash) &&
              (!('revokedAt' in where) || row.revokedAt === where.revokedAt) &&
              (!where.expiresAt?.gt || row.expiresAt > where.expiresAt.gt),
          );
          selected.forEach((row) => Object.assign(row, data));
          return Promise.resolve({ count: selected.length });
        }),
      },
      // Serialized transactions with rollback: service tests only, not a PostgreSQL lock substitute.
      $transaction: <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
        const run = tail.then(async () => {
          const snapshot = rows.map((row) => ({ ...row }));
          try {
            return await fn(db);
          } catch (error) {
            rows = snapshot;
            throw error;
          }
        });
        tail = run.catch(() => undefined);
        return run;
      },
    };
    return { service: new AuthService(db as unknown as PrismaService, jwt, config), jwt, user, rows: () => rows, config };
  };

  it('binds access and refresh tokens to the same saved session', async () => {
    const { service, jwt, user, rows } = setup();
    const tokens = await service.issueSession(user);
    expect(jwt.decode(tokens.accessToken).sid).toBe(jwt.decode(tokens.refreshToken).sid);
    expect(rows()[0].id).toBe(jwt.decode(tokens.accessToken).sid);
  });

  it('allows a parallel refresh inside the existing rotation grace window', async () => {
    const { service, user } = setup();
    const tokens = await service.issueSession(user);
    await service.refresh(tokens.refreshToken);
    await expect(service.refresh(tokens.refreshToken)).resolves.toHaveProperty('accessToken');
  });

  it('commits all session revocations before rejecting a replay outside the grace window', async () => {
    const { service, user, rows } = setup();
    const tokens = await service.issueSession(user);
    await service.refresh(tokens.refreshToken);
    rows()[0].revokedAt = new Date(Date.now() - 31000);
    await expect(service.refresh(tokens.refreshToken)).rejects.toThrow('Refresh session expired');
    expect(rows().every((row) => row.expiresAt <= new Date())).toBe(true);
  });

  it('cannot revive a session when refresh races with sign-out everywhere', async () => {
    const { service, user, rows } = setup();
    const tokens = await service.issueSession(user);
    const results = await Promise.allSettled([service.refresh(tokens.refreshToken), service.revokeAll(user.id)]);
    expect(results[1].status).toBe('fulfilled');
    expect(rows().every((row) => row.expiresAt <= new Date())).toBe(true);
    await expect(service.refresh(tokens.refreshToken)).rejects.toThrow('Refresh session expired');
  });

  it('does not count rotation history as additional signed-out devices', async () => {
    const { service, user } = setup();
    const tokens = await service.issueSession(user);
    await service.refresh(tokens.refreshToken);
    await expect(service.revokeOtherSessions(user.id)).resolves.toEqual({ signedOut: 1 });
  });
});
