import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

const REVOKED_SESSION_RETENTION_DAYS = 7;

/**
 * Background housekeeping. Runs in-process; with several PM2 instances each
 * instance runs the jobs, which is safe because every update is conditional.
 */
@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Every token refresh creates a session row; remove the dead ones. */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'refresh-session-cleanup' })
  async purgeRefreshSessions() {
    try {
      const cutoff = new Date(Date.now() - REVOKED_SESSION_RETENTION_DAYS * 86_400_000);
      const { count } = await this.prisma.refreshSession.deleteMany({
        where: { OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: cutoff } }] },
      });
      if (count) this.logger.log(`Removed ${count} expired or revoked refresh session(s)`);
    } catch (error) {
      this.logger.error('Refresh session cleanup failed', error instanceof Error ? error.stack : String(error));
    }
  }
}
