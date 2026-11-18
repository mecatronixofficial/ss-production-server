import { ArgumentsHost, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaExceptionFilter } from './prisma-exception.filter';

describe('Prisma HTTP errors', () => {
  const knownError = (code: string, meta?: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError('Private database connection details', {
      code,
      clientVersion: Prisma.prismaVersion.client,
      meta,
    });
  const initializationError = (code?: string) =>
    new Prisma.PrismaClientInitializationError('Private database connection details', Prisma.prismaVersion.client, code);

  beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  function respond(error: Prisma.PrismaClientKnownRequestError | Prisma.PrismaClientInitializationError) {
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const host = { switchToHttp: () => ({ getResponse: () => response }) } as unknown as ArgumentsHost;
    new PrismaExceptionFilter().catch(error, host);
    return response;
  }

  it.each(['P1001', 'P1002', 'P1017'])('returns 503 for runtime and initialization connection failures (%s)', (code) => {
    for (const error of [knownError(code), initializationError(code)]) {
      const response = respond(error);
      expect(response.status).toHaveBeenCalledWith(503);
      expect(response.json).toHaveBeenCalledWith({
        statusCode: 503,
        message: 'The database is temporarily unavailable. Please try again shortly.',
        error: 'SERVICE_UNAVAILABLE',
      });
    }
  });

  it.each(['P1000', 'P1012', undefined])('keeps configuration failures private (%s)', (code) => {
    const response = respond(initializationError(code));
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({ statusCode: 500, message: 'Internal server error', error: 'INTERNAL_SERVER_ERROR' });
  });

  it.each([
    ['P2003', 400],
    ['P2025', 404],
    ['P2024', 503],
    ['P2028', 503],
    ['P2034', 409],
    ['P9999', 500],
  ])('preserves the HTTP status for %s', (code, status) => {
    expect(respond(knownError(code)).status).toHaveBeenCalledWith(status);
  });

  it('preserves duplicate-field details', () => {
    const response = respond(knownError('P2002', { target: ['email'] }));
    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith({ statusCode: 409, message: 'A record with this email already exists', error: 'CONFLICT' });
  });
});
