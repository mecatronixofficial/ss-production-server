import { ConfigService } from '@nestjs/config';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtStrategy } from './jwt.strategy';

describe('Access token session validation', () => {
  let loggerWarn: jest.SpyInstance;
  beforeEach(() => {
    jest.useFakeTimers();
    loggerWarn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const connectionError = (code: string) =>
    new Prisma.PrismaClientKnownRequestError('Connection lost', {
      code,
      clientVersion: Prisma.prismaVersion.client,
    });
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

  it('keeps sharing a pending read after the cache window expires', async () => {
    const strategy = setup(active);
    let resolveRead!: (value: unknown) => void;
    strategy.db.refreshSession.findUnique.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );
    const first = strategy.validate(payload);
    await jest.advanceTimersByTimeAsync(6000);
    const second = strategy.validate(payload);
    expect(strategy.db.refreshSession.findUnique).toHaveBeenCalledTimes(1);
    resolveRead({ user, ...active });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    // A long read does not extend the original five-second freshness window.
    await strategy.validate(payload);
    expect(strategy.db.refreshSession.findUnique).toHaveBeenCalledTimes(2);
  });

  it('rechecks revocation after the successful cache window expires', async () => {
    const strategy = setup(active);
    await strategy.validate(payload);
    strategy.db.refreshSession.findUnique.mockResolvedValue({ user, ...active, revokedAt: new Date() });
    await jest.advanceTimersByTimeAsync(5000);
    await expect(strategy.validate(payload)).rejects.toThrow('Session expired');
    expect(strategy.db.refreshSession.findUnique).toHaveBeenCalledTimes(2);
  });

  it.each(['P1001', 'P1002', 'P1017'])('shares one retry of a transient read failure (%s)', async (code) => {
    const strategy = setup(active);
    strategy.db.refreshSession.findUnique.mockRejectedValueOnce(connectionError(code));
    const requests = Promise.all([strategy.validate(payload), strategy.validate(payload), strategy.validate(payload)]);
    await jest.runAllTimersAsync();
    await expect(requests).resolves.toHaveLength(3);
    expect(strategy.db.refreshSession.findUnique).toHaveBeenCalledTimes(2);
    expect(loggerWarn).toHaveBeenCalledTimes(1);
  });

  it.each(['P1001', 'P1002', 'P1017'])('retries initialization connection failures during a read (%s)', async (code) => {
    const strategy = setup(active);
    strategy.db.refreshSession.findUnique.mockRejectedValueOnce(
      new Prisma.PrismaClientInitializationError('Connection failed', Prisma.prismaVersion.client, code),
    );
    const result = strategy.validate(payload);
    await jest.runAllTimersAsync();
    await expect(result).resolves.toMatchObject({ id: user.id });
    expect(strategy.db.refreshSession.findUnique).toHaveBeenCalledTimes(2);
  });

  it('stops after one retry, propagates the outage and allows the next request to recover', async () => {
    const strategy = setup(active);
    const error = connectionError('P1017');
    strategy.db.refreshSession.findUnique.mockRejectedValueOnce(error).mockRejectedValueOnce(error);
    const results = Promise.allSettled([strategy.validate(payload), strategy.validate(payload)]);
    await jest.runAllTimersAsync();
    expect(await results).toEqual([
      { status: 'rejected', reason: error },
      { status: 'rejected', reason: error },
    ]);
    expect(strategy.db.refreshSession.findUnique).toHaveBeenCalledTimes(2);
    await expect(strategy.validate(payload)).resolves.toMatchObject({ id: user.id });
    expect(strategy.db.refreshSession.findUnique).toHaveBeenCalledTimes(3);
  });

  it.each([connectionError('P2002'), connectionError('P2024'), new Error('Unexpected failure')])(
    'does not retry other failures (%s)',
    async (error) => {
      const strategy = setup(active);
      strategy.db.refreshSession.findUnique.mockRejectedValueOnce(error);
      await expect(strategy.validate(payload)).rejects.toBe(error);
      expect(strategy.db.refreshSession.findUnique).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('still rejects a revoked session returned by the retry', async () => {
    const strategy = setup(active);
    strategy.db.refreshSession.findUnique
      .mockRejectedValueOnce(connectionError('P1017'))
      .mockResolvedValueOnce({ user, ...active, revokedAt: new Date() });
    const result = strategy.validate(payload).catch((error: unknown) => error);
    await jest.runAllTimersAsync();
    expect(await result).toBeInstanceOf(UnauthorizedException);
    expect(strategy.db.refreshSession.findUnique).toHaveBeenCalledTimes(2);
  });
});
