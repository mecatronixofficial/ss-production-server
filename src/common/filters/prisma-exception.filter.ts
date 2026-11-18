import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Response } from 'express';

/**
 * Maps Prisma's request and initialization errors to proper HTTP responses instead of a
 * generic 500. The body keeps Nest's `{ statusCode, message, error }` shape,
 * which the frontend reads to show toast messages.
 */
@Catch(Prisma.PrismaClientKnownRequestError, Prisma.PrismaClientInitializationError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(exception: Prisma.PrismaClientKnownRequestError | Prisma.PrismaClientInitializationError, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const [status, message] = this.map(exception);
    const code = exception instanceof Prisma.PrismaClientKnownRequestError ? exception.code : exception.errorCode;
    if (status >= 500) this.logger.error(`${code ?? 'unknown'}: ${exception.message}`, exception.stack);
    response.status(status).json({ statusCode: status, message, error: HttpStatus[status] ?? 'Error' });
  }

  private map(exception: Prisma.PrismaClientKnownRequestError | Prisma.PrismaClientInitializationError): [number, string] {
    const code = exception instanceof Prisma.PrismaClientKnownRequestError ? exception.code : exception.errorCode;
    if (code === 'P1001' || code === 'P1002' || code === 'P1017') {
      return [HttpStatus.SERVICE_UNAVAILABLE, 'The database is temporarily unavailable. Please try again shortly.'];
    }
    if (!(exception instanceof Prisma.PrismaClientKnownRequestError)) {
      return [HttpStatus.INTERNAL_SERVER_ERROR, 'Internal server error'];
    }
    switch (exception.code) {
      case 'P2002': {
        const target = exception.meta?.target;
        const fields = Array.isArray(target) ? target.join(', ') : typeof target === 'string' ? target : 'value';
        return [HttpStatus.CONFLICT, `A record with this ${fields} already exists`];
      }
      case 'P2003':
        return [HttpStatus.BAD_REQUEST, 'A referenced record does not exist or is still in use'];
      case 'P2025':
        return [HttpStatus.NOT_FOUND, 'Record not found'];
      case 'P2000':
        return [HttpStatus.BAD_REQUEST, 'A value is too long for its field'];
      case 'P2024':
        return [HttpStatus.SERVICE_UNAVAILABLE, 'The server is busy. Please retry in a moment.'];
      case 'P2028':
        return [HttpStatus.SERVICE_UNAVAILABLE, 'The request took too long and nothing was saved. Please retry.'];
      case 'P2034':
        return [HttpStatus.CONFLICT, 'The record was changed by another request. Please retry.'];
      default:
        return [HttpStatus.INTERNAL_SERVER_ERROR, 'Internal server error'];
    }
  }
}
