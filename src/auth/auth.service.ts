import { BadRequestException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import * as argon2 from 'argon2';
import { createHash, randomUUID } from 'crypto';
import { LoginDto } from './dto/login.dto';
import { notifyRoles, notifyUser } from '../notifications/notify.util';
import { ADMIN_ROLES } from '../common/roles';

type SessionUser = { id: string; email: string; name: string; role: Role };

const REFRESH_REUSE_GRACE_MS = 30_000;

/**
 * Data for an explicit sign-out (logout, "sign out device", password change, admin changes).
 * Token rotation only sets `revokedAt`, which keeps a short grace window for parallel refreshes and
 * treats later reuse as theft. A deliberate sign-out also expires the session, so its token is
 * refused outright: no grace window, and no false theft alarm that would end the user's other sessions.
 */
const endedSession = () => {
  const now = new Date();
  return { revokedAt: now, expiresAt: now };
};
/** One reset request per account in this window, so the endpoint can't flood admins. */
const RESET_REQUEST_COOLDOWN_MS = 15 * 60_000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  // Verifying against a dummy hash when the email is unknown keeps response
  // time the same, so attackers cannot probe which emails exist.
  private dummyHash?: Promise<string>;
  // Reset requests run in the background, so back-to-back requests could both pass the cooldown check.
  private readonly pendingResets = new Set<string>();

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  private hashToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  async validateCredentials(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email.trim().toLowerCase() } });
    if (!user) {
      this.dummyHash ??= argon2.hash(randomUUID());
      await argon2.verify(await this.dummyHash, dto.password).catch(() => false);
      throw new UnauthorizedException('Invalid email or password');
    }
    const valid = await argon2.verify(user.passwordHash, dto.password).catch(() => false);
    if (!valid || user.status !== 'ACTIVE') throw new UnauthorizedException('Invalid email or password');
    return user;
  }

  async issueSession(user: SessionUser, userAgent?: string, ipAddress?: string) {
    const payload = { sub: user.id, email: user.email, name: user.name, role: user.role };
    const sid = randomUUID();
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(payload, {
        secret: this.config.getOrThrow('JWT_ACCESS_SECRET'),
        expiresIn: this.config.get('ACCESS_TOKEN_EXPIRES', '15m'),
      }),
      this.jwt.signAsync(
        { ...payload, sid },
        {
          secret: this.config.getOrThrow('JWT_REFRESH_SECRET'),
          expiresIn: this.config.get('REFRESH_TOKEN_EXPIRES', '7d'),
        },
      ),
    ]);
    const decoded = this.jwt.decode(refreshToken);
    await this.prisma.refreshSession.create({
      data: {
        id: sid,
        userId: user.id,
        tokenHash: this.hashToken(refreshToken),
        userAgent: userAgent?.slice(0, 500),
        ipAddress,
        expiresAt: new Date(decoded.exp * 1000),
      },
    });
    return { accessToken, refreshToken };
  }

  async refresh(refreshToken: string, userAgent?: string, ipAddress?: string) {
    let payload: { sub: string; sid: string };
    try {
      payload = await this.jwt.verifyAsync<{ sub: string; sid: string }>(refreshToken, {
        secret: this.config.getOrThrow('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Refresh session expired');
    }

    const session = await this.prisma.refreshSession.findUnique({ where: { id: payload.sid }, include: { user: true } });
    if (!session || session.tokenHash !== this.hashToken(refreshToken) || session.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh session expired');
    }
    // The browser often refreshes several parallel requests with the same
    // cookie, so a token rotated a few seconds ago is still accepted. Reuse
    // after that window means a stolen or replayed token: end every session.
    if (session.revokedAt && Date.now() - session.revokedAt.getTime() > REFRESH_REUSE_GRACE_MS) {
      this.logger.warn(`Refresh token reuse detected for user ${session.userId}; revoking all sessions`);
      await this.revokeAll(session.userId);
      throw new UnauthorizedException('Refresh session expired');
    }
    if (session.user.status !== 'ACTIVE') {
      await this.revokeAll(session.userId);
      throw new UnauthorizedException('Account is not active');
    }

    await this.prisma.refreshSession.updateMany({ where: { id: session.id, revokedAt: null }, data: { revokedAt: new Date() } });
    return this.issueSession(session.user, userAgent, ipAddress);
  }

  async revoke(refreshToken?: string) {
    if (!refreshToken) return;
    const decoded = this.jwt.decode(refreshToken);
    if (decoded?.sid) await this.prisma.refreshSession.updateMany({ where: { id: decoded.sid, revokedAt: null }, data: endedSession() });
  }

  /**
   * There is no mail transport, so a reset request asks the super admins (in-app) to set a
   * new password from Users. Unknown or inactive emails are ignored silently.
   */
  async requestPasswordReset(email: string, userAgent?: string, ipAddress?: string) {
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user || user.status !== 'ACTIVE' || this.pendingResets.has(user.id)) return;
    this.pendingResets.add(user.id);
    try {
      await this.notifyResetRequested(user, userAgent, ipAddress);
    } finally {
      this.pendingResets.delete(user.id);
    }
  }

  private async notifyResetRequested(user: SessionUser, userAgent?: string, ipAddress?: string) {
    const recent = await this.prisma.auditLog.findFirst({
      where: {
        action: 'PASSWORD_RESET_REQUESTED',
        entityId: user.id,
        createdAt: { gt: new Date(Date.now() - RESET_REQUEST_COOLDOWN_MS) },
      },
      select: { id: true },
    });
    if (recent) return;

    await this.prisma.$transaction(async (tx) => {
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: 'PASSWORD_RESET_REQUESTED',
          module: 'auth',
          entity: 'User',
          entityId: user.id,
          ipAddress,
          userAgent: userAgent?.slice(0, 500),
        },
      });
      await notifyRoles(tx, ADMIN_ROLES, {
        title: 'Password reset requested',
        message: `${user.name} (${user.email}) asked for a password reset. Set a new password in Users.`,
        type: 'SYSTEM',
        priority: 'HIGH',
        referenceType: 'User',
        referenceId: user.id,
      });
    });
  }

  /** Session id (`sid`) of a refresh token; the cookie is httpOnly and signed by us, so decoding is enough to spot "this device". */
  sessionIdOf(refreshToken?: string): string | undefined {
    if (!refreshToken) return undefined;
    const decoded = this.jwt.decode<{ sid?: string } | null>(refreshToken);
    return decoded?.sid;
  }

  async profile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        status: true,
        createdAt: true,
        employee: { select: { code: true, name: true, department: true, shift: true, mobile: true, joiningDate: true } },
      },
    });
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException('Account is not active');
    const lastPasswordChange = await this.prisma.auditLog.findFirst({
      where: {
        entity: 'User',
        entityId: userId,
        action: { in: ['PASSWORD_CHANGED', 'USER_UPDATED'] },
        newValue: { path: ['passwordChanged'], equals: true },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return { ...user, passwordChangedAt: lastPasswordChange?.createdAt ?? null };
  }

  async updateProfile(userId: string, name: string) {
    const current = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } });
    if (current.name === name) return;
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { name } }),
      this.prisma.auditLog.create({
        data: {
          actorId: userId,
          action: 'PROFILE_UPDATED',
          module: 'auth',
          entity: 'User',
          entityId: userId,
          previousValue: { name: current.name },
          newValue: { name },
        },
      }),
    ]);
  }

  /** Verifies the current password, stores the new one and signs out every other device. */
  async changePassword(userId: string, currentPassword: string, newPassword: string, keepSessionId?: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const valid = await argon2.verify(user.passwordHash, currentPassword).catch(() => false);
    if (!valid) throw new BadRequestException('Current password is incorrect');
    if (currentPassword === newPassword) throw new BadRequestException('Choose a password different from the current one');

    const passwordHash = await argon2.hash(newPassword);
    const signedOut = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { passwordHash } });
      const revoked = await tx.refreshSession.updateMany({
        where: { userId, revokedAt: null, ...(keepSessionId ? { id: { not: keepSessionId } } : {}) },
        data: endedSession(),
      });
      await tx.auditLog.create({
        data: {
          actorId: userId,
          action: 'PASSWORD_CHANGED',
          module: 'auth',
          entity: 'User',
          entityId: userId,
          newValue: { passwordChanged: true, otherSessionsSignedOut: revoked.count },
        },
      });
      await notifyUser(tx, userId, {
        title: 'Password changed',
        message: 'Your password was changed. If this wasn’t you, contact your administrator immediately.',
        type: 'SYSTEM',
        priority: 'HIGH',
        referenceType: 'User',
        referenceId: userId,
      });
      return revoked.count;
    });
    return { otherSessionsSignedOut: signedOut };
  }

  async listSessions(userId: string, currentSessionId?: string) {
    const sessions = await this.prisma.refreshSession.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, userAgent: true, ipAddress: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: 'desc' },
    });
    // The current device first.
    return sessions
      .map((session) => ({ ...session, current: session.id === currentSessionId }))
      .sort((a, b) => Number(b.current) - Number(a.current));
  }

  async revokeSession(userId: string, sessionId: string) {
    const revoked = await this.prisma.refreshSession.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: endedSession(),
    });
    if (!revoked.count) throw new NotFoundException('Session not found or already signed out');
  }

  async revokeOtherSessions(userId: string, currentSessionId?: string) {
    const revoked = await this.prisma.refreshSession.updateMany({
      where: { userId, revokedAt: null, ...(currentSessionId ? { id: { not: currentSessionId } } : {}) },
      data: endedSession(),
    });
    return { signedOut: revoked.count };
  }

  async revokeAll(userId: string) {
    await this.prisma.refreshSession.updateMany({ where: { userId, revokedAt: null }, data: endedSession() });
  }
}
