import { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service';

describe('Database startup retries', () => {
  const originalRetries = process.env.DATABASE_CONNECT_RETRIES;
  const connect = jest.fn<Promise<void>, []>();
  const logger = { warn: jest.fn() };
  const initialize = () => PrismaService.prototype.onModuleInit.call({ $connect: connect, logger } as unknown as PrismaService);
  const failure = (code?: string) =>
    new Prisma.PrismaClientInitializationError('Database initialization failed', Prisma.prismaVersion.client, code);

  beforeEach(() => {
    jest.useFakeTimers();
    connect.mockReset();
    logger.warn.mockReset();
    process.env.DATABASE_CONNECT_RETRIES = '5';
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalRetries === undefined) delete process.env.DATABASE_CONNECT_RETRIES;
    else process.env.DATABASE_CONNECT_RETRIES = originalRetries;
  });

  it.each(['P1000', 'P1010', 'P1012', 'P1013', undefined])('does not retry configuration or credential errors (%s)', async (code) => {
    const error = failure(code);
    connect.mockRejectedValue(error);
    const result = initialize().catch((caught: unknown) => caught);
    await jest.runAllTimersAsync();
    expect(await result).toBe(error);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['P1001', 'P1002', 'P1017'])('retries a transient connection failure (%s)', async (code) => {
    connect.mockRejectedValueOnce(failure(code)).mockResolvedValue(undefined);
    const started = initialize();
    await jest.runAllTimersAsync();
    await started;
    expect(connect).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('stops at the configured retry limit with bounded backoff', async () => {
    const error = failure('P1001');
    connect.mockRejectedValue(error);
    const start = Date.now();
    const result = initialize().catch((caught: unknown) => caught);
    await jest.runAllTimersAsync();
    expect(await result).toBe(error);
    expect(connect).toHaveBeenCalledTimes(5);
    expect(logger.warn).toHaveBeenCalledTimes(4);
    expect(Date.now() - start).toBe(29000);
  });

  it('honors a single connection attempt', async () => {
    process.env.DATABASE_CONNECT_RETRIES = '1';
    const error = failure('P1001');
    connect.mockRejectedValue(error);
    await expect(initialize()).rejects.toBe(error);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not retry unrelated failures', async () => {
    const error = new Error('Unexpected failure');
    connect.mockRejectedValue(error);
    await expect(initialize()).rejects.toBe(error);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
