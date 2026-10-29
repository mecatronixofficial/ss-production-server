import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const cookieExtractor = (req: Request) => req?.cookies?.access_token ?? null;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
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
   * Access tokens live for minutes, so the role and status inside one can be stale. Reading the user
   * and its session on every request makes deactivation, role changes and sign-out take effect immediately.
   */
  async validate(payload: { sub: string; email: string; name: string; role: Role; sid?: string }) {
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') throw new UnauthorizedException('Session expired');
    const [user, session] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, email: true, name: true, role: true, status: true },
      }),
      this.prisma.refreshSession.findUnique({
        where: { id: payload.sid },
        select: { userId: true, revokedAt: true, expiresAt: true },
      }),
    ]);
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException('Account is not active');
    if (!session || session.userId !== user.id || session.revokedAt || session.expiresAt <= new Date()) {
      throw new UnauthorizedException('Session expired');
    }
    return { id: user.id, email: user.email, name: user.name, role: user.role };
  }
}
