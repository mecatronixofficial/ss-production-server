import { NotificationPriority, NotificationType, Prisma, PrismaClient, Role } from '@prisma/client';
import { ADMIN_ROLES } from '../common/roles';

type Client = PrismaClient | Prisma.TransactionClient;

export type NotifyPayload = {
  title: string;
  message: string;
  type: NotificationType;
  priority?: NotificationPriority;
  referenceType?: string;
  referenceId?: string;
};

export async function notifyUser(prisma: Client, userId: string, payload: NotifyPayload) {
  return prisma.notification.create({ data: { userId, ...payload } });
}

export async function notifyUsers(prisma: Client, userIds: string[], payload: NotifyPayload) {
  const unique = Array.from(new Set(userIds.filter(Boolean)));
  if (!unique.length) return { count: 0 };
  return prisma.notification.createMany({ data: unique.map((userId) => ({ userId, ...payload })) });
}

export async function notifyRoles(prisma: Client, roles: Role[], payload: NotifyPayload, excludeUserId?: string) {
  const users = await prisma.user.findMany({
    where: { role: { in: roles }, status: 'ACTIVE', ...(excludeUserId ? { id: { not: excludeUserId } } : {}) },
    select: { id: true },
  });
  return notifyUsers(
    prisma,
    users.map((u) => u.id),
    payload,
  );
}

export const MANAGEMENT_ROLES: Role[] = ADMIN_ROLES;

/** "500 KG 30s yarn, 40 CONE Polyester +2 more": the material a notification is about. */
export const linesText = (lines: Array<{ quantity: number; unit: string; itemName: string }>, max = 3) =>
  lines
    .slice(0, max)
    .map((l) => `${Number(l.quantity.toFixed(3))} ${l.unit} ${l.itemName}`)
    .join(', ') + (lines.length > max ? ` +${lines.length - max} more` : '');

/**
 * Marks the unread "to do" reminders about a document (material to receive, a sale to dispatch…) read once the work
 * is done, cancelled or replaced, so nobody keeps acting on a stale one.
 */
export function settleReminders(prisma: Client, referenceType: string, referenceId: string) {
  return prisma.notification.updateMany({
    where: { referenceType, referenceId, type: NotificationType.DELIVERY_DUE, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });
}
