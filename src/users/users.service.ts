import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import * as argon2 from 'argon2';
import { AuthService } from '../auth/auth.service';
import { AuthUser } from '../common/auth-user';
import { CreateUserDto, UpdateUserDto } from './dto/create-user.dto';

const userSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  status: true,
  employeeId: true,
  createdAt: true,
  employee: { select: { id: true, code: true, name: true, department: true } },
} as const;

/** Reset requests older than this are no longer flagged. */
const RESET_REQUEST_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private auth: AuthService,
  ) {}

  /** Users with activity details: last sign-in activity, open sessions and any pending password reset request. */
  async list() {
    const now = new Date();
    const [users, lastActive, openSessions, resetRequests, passwordChanges] = await Promise.all([
      this.prisma.user.findMany({ select: userSelect, orderBy: { createdAt: 'desc' } }),
      // Sessions rotate on every refresh, so the newest one marks the last time the user was active.
      this.prisma.refreshSession.groupBy({ by: ['userId'], _max: { createdAt: true } }),
      this.prisma.refreshSession.groupBy({ by: ['userId'], where: { revokedAt: null, expiresAt: { gt: now } }, _count: { _all: true } }),
      this.prisma.auditLog.findMany({
        where: { action: 'PASSWORD_RESET_REQUESTED', createdAt: { gt: new Date(now.getTime() - RESET_REQUEST_WINDOW_MS) } },
        select: { entityId: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.auditLog.findMany({
        where: {
          entity: 'User',
          action: { in: ['USER_UPDATED', 'PASSWORD_CHANGED'] },
          newValue: { path: ['passwordChanged'], equals: true },
          createdAt: { gt: new Date(now.getTime() - RESET_REQUEST_WINDOW_MS) },
        },
        select: { entityId: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const lastActiveBy = new Map(lastActive.map((row) => [row.userId, row._max.createdAt]));
    const sessionsBy = new Map(openSessions.map((row) => [row.userId, row._count._all]));
    const latest = (rows: Array<{ entityId: string | null; createdAt: Date }>) => {
      const map = new Map<string, Date>();
      for (const row of rows) if (row.entityId && !map.has(row.entityId)) map.set(row.entityId, row.createdAt);
      return map;
    };
    const requestedBy = latest(resetRequests);
    const changedBy = latest(passwordChanges);

    return users.map((user) => {
      const requested = requestedBy.get(user.id);
      const changed = changedBy.get(user.id);
      return {
        ...user,
        lastActiveAt: lastActiveBy.get(user.id) ?? null,
        activeSessions: sessionsBy.get(user.id) ?? 0,
        // Still pending only if no password was set after the request.
        resetRequestedAt: requested && (!changed || changed < requested) ? requested : null,
      };
    });
  }

  /**
   * One user's page: the same row as the list, plus the devices signed in now, what they did recently, and the
   * changes others made to their account.
   */
  async details(id: string) {
    const row = (await this.list()).find((user) => user.id === id);
    if (!row) throw new NotFoundException('User not found');
    const [sessions, activity, accountChanges] = await Promise.all([
      this.prisma.refreshSession.findMany({
        where: { userId: id, revokedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true, userAgent: true, ipAddress: true, createdAt: true, expiresAt: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.auditLog.findMany({
        where: { actorId: id },
        select: { id: true, action: true, module: true, entity: true, entityId: true, ipAddress: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.prisma.auditLog.findMany({
        where: { entity: 'User', entityId: id },
        select: { id: true, action: true, createdAt: true, actor: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
    ]);
    return { user: row, sessions, activity, accountChanges };
  }

  /** An employee can be linked to one login at most. */
  private async assertEmployeeAvailable(employeeId: string, userId?: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { code: true, name: true, active: true, user: { select: { id: true, email: true } } },
    });
    if (!employee) throw new BadRequestException('Employee not found');
    // An existing link survives deactivation; only new links need an active employee.
    if (!employee.active && employee.user?.id !== userId) {
      throw new BadRequestException(`Employee ${employee.code} (${employee.name}) is inactive`);
    }
    if (employee.user && employee.user.id !== userId) {
      throw new ConflictException(`Employee ${employee.code} (${employee.name}) is already linked to ${employee.user.email}`);
    }
  }

  /** Only a Super Admin may create, promote to, or manage Super Admin accounts. */
  private assertCanManage(actor: AuthUser, ...roles: Array<Role | undefined>) {
    if (actor.role !== Role.SUPERADMIN && roles.includes(Role.SUPERADMIN)) {
      throw new ForbiddenException('Only a Super Admin can manage Super Admin accounts');
    }
  }

  async create(dto: CreateUserDto, actor: AuthUser) {
    const actorId = actor.id;
    this.assertCanManage(actor, dto.role);
    const email = dto.email.toLowerCase();
    const exists = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (exists) throw new ConflictException('A user with this email already exists');
    if (dto.employeeId) await this.assertEmployeeAvailable(dto.employeeId);

    const passwordHash = await argon2.hash(dto.password);
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { name: dto.name, email, passwordHash, role: dto.role, employeeId: dto.employeeId },
        select: userSelect,
      });
      await tx.auditLog.create({
        data: {
          actorId,
          action: 'USER_CREATED',
          module: 'users',
          entity: 'User',
          entityId: user.id,
          newValue: { name: user.name, email: user.email, role: user.role, employee: user.employee?.code ?? null },
        },
      });
      return user;
    });
  }

  async update(id: string, dto: UpdateUserDto, actor: AuthUser) {
    const actorId = actor.id;
    const user = await this.prisma.user.findUnique({ where: { id }, include: { employee: { select: { code: true } } } });
    if (!user) throw new NotFoundException('User not found');
    this.assertCanManage(actor, user.role, dto.role);
    if (id === actorId && ((dto.status && dto.status !== 'ACTIVE') || (dto.role && dto.role !== user.role))) {
      throw new BadRequestException('You cannot deactivate yourself or change your own role');
    }
    if (dto.employeeId && dto.employeeId !== user.employeeId) await this.assertEmployeeAvailable(dto.employeeId, id);

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        name: dto.name,
        role: dto.role,
        status: dto.status,
        employeeId: dto.employeeId,
        ...(dto.password ? { passwordHash: await argon2.hash(dto.password) } : {}),
      },
      select: userSelect,
    });
    // Role, status or password changes must not survive in existing sessions.
    if (dto.password || (dto.status && dto.status !== 'ACTIVE') || (dto.role && dto.role !== user.role)) {
      await this.auth.revokeAll(id);
    }
    await this.prisma.auditLog.create({
      data: {
        actorId,
        action: 'USER_UPDATED',
        module: 'users',
        entity: 'User',
        entityId: id,
        previousValue: { name: user.name, role: user.role, status: user.status, employee: user.employee?.code ?? null },
        newValue: {
          name: updated.name,
          role: updated.role,
          status: updated.status,
          employee: updated.employee?.code ?? null,
          passwordChanged: !!dto.password,
        } satisfies Prisma.InputJsonObject,
      },
    });
    return updated;
  }

  /**
   * Permanently removes a login that has no recorded work. Anyone who has acted in the system is
   * referenced by audit records, so they must be deactivated instead to keep history attributed.
   */
  async remove(id: string, actor: AuthUser) {
    const actorId = actor.id;
    if (id === actorId) throw new BadRequestException('You cannot delete your own account');
    const user = await this.prisma.user.findUnique({ where: { id }, include: { employee: { select: { code: true } } } });
    if (!user) throw new NotFoundException('User not found');
    this.assertCanManage(actor, user.role);

    // Housekeeping on their own account (profile, password) doesn't count as work.
    const audit = await this.prisma.auditLog.count({
      where: { actorId: id, NOT: { entityId: id, action: { in: ['PASSWORD_RESET_REQUESTED', 'PROFILE_UPDATED', 'PASSWORD_CHANGED'] } } },
    });
    if (audit) {
      throw new ConflictException(`${user.name} has recorded work (${audit} logged action${audit === 1 ? '' : 's'}). Deactivate the account instead to keep that history.`);
    }

    // Sessions and notifications cascade; the JWT strategy rejects any access token still in flight.
    await this.prisma.$transaction([
      this.prisma.user.delete({ where: { id } }),
      this.prisma.auditLog.create({
        data: {
          actorId,
          action: 'USER_DELETED',
          module: 'users',
          entity: 'User',
          entityId: id,
          previousValue: { name: user.name, email: user.email, role: user.role, status: user.status, employee: user.employee?.code ?? null },
        },
      }),
    ]);
    return { deleted: true };
  }

  /** Ends every session of another user; they must sign in again. */
  async signOutEverywhere(id: string, actor: AuthUser) {
    const actorId = actor.id;
    if (id === actorId) throw new BadRequestException('Use your profile page to sign out your own devices');
    const user = await this.prisma.user.findUnique({ where: { id }, select: { id: true, role: true } });
    if (!user) throw new NotFoundException('User not found');
    this.assertCanManage(actor, user.role);
    const open = await this.prisma.refreshSession.count({ where: { userId: id, revokedAt: null, expiresAt: { gt: new Date() } } });
    await this.auth.revokeAll(id);
    await this.prisma.auditLog.create({
      data: { actorId, action: 'USER_SESSIONS_REVOKED', module: 'users', entity: 'User', entityId: id, newValue: { sessions: open } },
    });
    return { signedOut: open };
  }
}
