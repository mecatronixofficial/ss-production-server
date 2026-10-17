import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { CookieOptions, Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ChangePasswordDto, UpdateProfileDto } from './dto/profile.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/auth-user';
import { durationToMs } from '../common/duration';
import { PrismaService } from '../prisma/prisma.service';
import { notifyUser } from '../notifications/notify.util';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  private readonly accessMaxAge: number;
  private readonly refreshMaxAge: number;

  constructor(
    private auth: AuthService,
    private config: ConfigService,
    private prisma: PrismaService,
  ) {
    // Cookie lifetimes follow the token lifetimes instead of being hard-coded.
    this.accessMaxAge = durationToMs(config.get<string>('ACCESS_TOKEN_EXPIRES'), 15 * 60 * 1000);
    this.refreshMaxAge = durationToMs(config.get<string>('REFRESH_TOKEN_EXPIRES'), 7 * 24 * 60 * 60 * 1000);
  }

  private cookieOptions(maxAge: number, refresh = false): CookieOptions {
    const prod = this.config.get('NODE_ENV') === 'production';
    const domain = this.config.get<string>('COOKIE_DOMAIN');
    return { httpOnly: true, secure: prod, sameSite: 'lax', maxAge, path: refresh ? '/api/v1/auth' : '/', ...(domain ? { domain } : {}) };
  }

  private setTokens(res: Response, accessToken: string, refreshToken: string) {
    res.cookie('access_token', accessToken, this.cookieOptions(this.accessMaxAge));
    res.cookie('refresh_token', refreshToken, this.cookieOptions(this.refreshMaxAge, true));
  }

  private clearTokens(res: Response) {
    const { maxAge: _a, ...access } = this.cookieOptions(0);
    const { maxAge: _r, ...refresh } = this.cookieOptions(0, true);
    res.clearCookie('access_token', access);
    res.clearCookie('refresh_token', refresh);
  }

  @Post('login')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const user = await this.auth.validateCredentials(dto);
    const tokens = await this.auth.issueSession(user, req.headers['user-agent'], req.ip);
    this.setTokens(res, tokens.accessToken, tokens.refreshToken);
    await notifyUser(this.prisma, user.id, {
      title: 'New login',
      message: `Signed in from ${req.ip || 'an unknown IP'}`,
      type: 'SYSTEM',
      priority: 'LOW',
      referenceType: 'User',
      referenceId: user.id,
    });
    return { success: true, message: 'Login successful', data: { id: user.id, name: user.name, email: user.email, role: user.role } };
  }

  @Post('forgot-password')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    // Not awaited: the reply is identical and equally fast whether or not the email exists.
    this.auth
      .requestPasswordReset(dto.email, req.headers['user-agent'], req.ip)
      .catch((error: unknown) => this.logger.error('Password reset request failed', error instanceof Error ? error.stack : String(error)));
    return {
      success: true,
      message: 'If an active account uses this email, an administrator has been asked to reset its password.',
    };
  }

  @Post('refresh')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.refresh_token as string | undefined;
    try {
      const tokens = await this.auth.refresh(token ?? '', req.headers['user-agent'], req.ip);
      this.setTokens(res, tokens.accessToken, tokens.refreshToken);
      return { success: true };
    } catch (error) {
      this.clearTokens(res);
      throw error;
    }
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.revoke(req.cookies?.refresh_token);
    this.clearTokens(res);
    return { success: true, message: 'Logged out' };
  }

  @Get('me')
  @UseGuards(AuthGuard('jwt'))
  async me(@CurrentUser() user: AuthUser) {
    // Read from the database so a renamed or deactivated account shows up without waiting for a new token.
    const { id, name, email, role } = await this.auth.profile(user.id);
    return { success: true, data: { id, name, email, role } };
  }

  @Get('profile')
  @UseGuards(AuthGuard('jwt'))
  profile(@CurrentUser() user: AuthUser) {
    return this.auth.profile(user.id);
  }

  @Patch('profile')
  @UseGuards(AuthGuard('jwt'))
  async updateProfile(
    @Body() dto: UpdateProfileDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.updateProfile(user.id, dto.name);
    // Tokens carry the display name, so rotate this device's session to pick up the change now.
    const refreshToken = req.cookies?.refresh_token as string | undefined;
    if (refreshToken) {
      const tokens = await this.auth.refresh(refreshToken, req.headers['user-agent'], req.ip).catch(() => null);
      if (tokens) this.setTokens(res, tokens.accessToken, tokens.refreshToken);
    }
    return this.auth.profile(user.id);
  }

  @Post('change-password')
  @HttpCode(200)
  @UseGuards(AuthGuard('jwt'))
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  changePassword(@Body() dto: ChangePasswordDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.auth.changePassword(user.id, dto.currentPassword, dto.newPassword, this.currentSessionId(req));
  }

  @Get('sessions')
  @UseGuards(AuthGuard('jwt'))
  sessions(@CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.auth.listSessions(user.id, this.currentSessionId(req));
  }

  @Post('sessions/revoke-others')
  @HttpCode(200)
  @UseGuards(AuthGuard('jwt'))
  revokeOthers(@CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.auth.revokeOtherSessions(user.id, this.currentSessionId(req));
  }

  @Delete('sessions/:id')
  @UseGuards(AuthGuard('jwt'))
  async revokeSession(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Req() req: Request) {
    if (id === this.currentSessionId(req)) throw new BadRequestException('Use “Sign out” to end the session on this device');
    await this.auth.revokeSession(user.id, id);
    return { success: true };
  }

  /** The refresh cookie is scoped to /api/v1/auth, so it is only visible to routes in this controller. */
  private currentSessionId(req: Request) {
    return this.auth.sessionIdOf(req.cookies?.refresh_token as string | undefined);
  }
}
