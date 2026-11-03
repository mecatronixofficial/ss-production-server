import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const cookieExtractor = (req: Request) => req?.cookies?.access_token ?? null;

/**
 * A page load sends several API requests at once, and each one checks the session. Remembering the answer briefly
 * lets that burst share a single database read. It also bounds how long a sign-out, deactivation or role change can
 * take to apply: at most this long.
 */
const SESSION_CACHE_MS = 5_000;
const SESSION_CACHE_MAX = 1_000;

const lookupSession = (prisma: PrismaService, sessionId: string) =>
  prisma.refreshSession.findUnique({
    where: { id: sessionId },
    select: {
      userId: true,
      revokedAt: true,
      expiresAt: true,
      user: { select: { id: true, email: true, name: true, role: true, status: true } },
    },
  });

type SessionLookup = ReturnType<typeof lookupSession>;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly sessions = new Map<string, { at: number; lookup: SessionLookup }>();

  constructor(
    config: ConfigService,
    private prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([cookieExtractor, ExtractJwt.fromAuthHeaderAsBearerToken()]),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  /**
   * Access tokens live for minutes, so the role and status inside one can be stale. Reading the user and its session
   * (one query, shared for a few seconds) makes deactivation, role changes and sign-out take effect almost at once.
   */
  async validate(payload: { sub: string; email: string; name: string; role: Role; sid?: string }) {
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') throw new UnauthorizedException('Session expired');
    const session = await this.session(payload.sid);
    if (!session) throw new UnauthorizedException('Session expired');
    const { user } = session;
    if (user.status !== 'ACTIVE') throw new UnauthorizedException('Account is not active');
    if (session.userId !== payload.sub || session.revokedAt || session.expiresAt <= new Date()) {
      throw new UnauthorizedException('Session expired');
    }
    return { id: user.id, email: user.email, name: user.name, role: user.role };
  }

  private session(sessionId: string) {
    const now = Date.now();
    const cached = this.sessions.get(sessionId);
    if (cached && now - cached.at < SESSION_CACHE_MS) return cached.lookup;
    if (this.sessions.size >= SESSION_CACHE_MAX) {
      for (const [key, entry] of this.sessions) if (now - entry.at >= SESSION_CACHE_MS) this.sessions.delete(key);
    }
    const lookup = lookupSession(this.prisma, sessionId);
    this.sessions.set(sessionId, { at: now, lookup });
    // A failed read is not remembered: the next request tries again.
    lookup.catch(() => this.sessions.get(sessionId)?.lookup === lookup && this.sessions.delete(sessionId));
    return lookup;
  }
}
