import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { PrismaService } from './prisma/prisma.service';

@Controller('health')
@SkipThrottle()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async health() {
    const started = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({ status: 'error', database: 'unreachable', timestamp: new Date().toISOString() });
    }
    return {
      status: 'ok',
      database: 'connected',
      dbLatencyMs: Date.now() - started,
      uptimeSec: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}
