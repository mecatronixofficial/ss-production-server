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
   * on every request makes deactivation and role changes take effect immediately (a primary-key lookup).
   */
  async validate(payload: { sub: string; email: string; name: string; role: Role }) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, name: true, role: true, status: true },
    });
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException('Account is not active');
    return { id: user.id, email: user.email, name: user.name, role: user.role };
  }
}
