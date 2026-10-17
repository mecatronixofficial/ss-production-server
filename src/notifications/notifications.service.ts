import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class NotificationsService {
  constructor(private prisma: PrismaService) {}

  list(userId: string) {
    return this.prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  /** Unread notifications made after `since` (newest first, at most 5): what to pop up as a message right now. */
  latest(userId: string, since?: Date) {
    return this.prisma.notification.findMany({
      where: { userId, isRead: false, ...(since ? { createdAt: { gt: since } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, title: true, message: true, type: true, priority: true, createdAt: true, referenceType: true, referenceId: true },
    });
  }

  async unreadCount(userId: string) {
    return { count: await this.prisma.notification.count({ where: { userId, isRead: false } }) };
  }

  read(userId: string, id: string) {
    return this.prisma.notification.updateMany({ where: { id, userId, isRead: false }, data: { isRead: true, readAt: new Date() } });
  }

  readAll(userId: string) {
    return this.prisma.notification.updateMany({ where: { userId, isRead: false }, data: { isRead: true, readAt: new Date() } });
  }

  // Scoped by userId so users can only delete their own notifications; deleting twice is a no-op.
  remove(userId: string, id: string) {
    return this.prisma.notification.deleteMany({ where: { id, userId } });
  }

  removeAll(userId: string) {
    return this.prisma.notification.deleteMany({ where: { userId } });
  }
}
