import { Logger } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

const SLOW_REQUEST_MS = 1000;

/** Logs failed and slow requests with their duration; quiet for fast successes. */
export function requestLogger() {
  const logger = new Logger('HTTP');
  return (req: Request, res: Response, next: NextFunction) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const line = `${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(0)}ms - ${req.ip}`;
      if (res.statusCode >= 500) logger.error(line);
      else if (res.statusCode >= 400 || ms >= SLOW_REQUEST_MS) logger.warn(line);
      else if (process.env.LOG_ALL_REQUESTS === 'true') logger.log(line);
    });
    next();
  };
}
