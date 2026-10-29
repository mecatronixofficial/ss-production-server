import 'reflect-metadata';
import { INestApplication, RequestMethod, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Role } from '@prisma/client';
import cookieParser from 'cookie-parser';
import { AuthController } from '../src/auth/auth.controller';
import { JwtStrategy } from '../src/auth/jwt.strategy';
import { AuthService } from '../src/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { ROLES_KEY } from '../src/common/decorators/roles.decorator';
import { AdminController } from '../src/admin/admin.controller';
import { AuditLogsController } from '../src/admin/audit-logs.controller';
import { UsersController } from '../src/users/users.controller';
import { DashboardController } from '../src/dashboard/dashboard.controller';
import { MastersController } from '../src/masters/masters.controller';
import { InventoryController } from '../src/inventory/inventory.controller';
import { ProductionController } from '../src/production/production.controller';
import { NotificationsController } from '../src/notifications/notifications.controller';
import { ReportsController } from '../src/reports/reports.controller';
import { FinanceController } from '../src/finance/finance.controller';
import { MoneyController } from '../src/finance/money.controller';
import { StorageController } from '../src/storage/storage.controller';
import { ProcurementController } from '../src/procurement/procurement.controller';
import { SalesController } from '../src/sales/sales.controller';
import { KnittingController } from '../src/knitting/knitting.controller';
import { SearchController } from '../src/search/search.controller';
import { HealthController } from '../src/health.controller';

const controllers = [
  AuthController,
  AdminController,
  AuditLogsController,
  UsersController,
  DashboardController,
  MastersController,
  InventoryController,
  ProductionController,
  NotificationsController,
  ReportsController,
  FinanceController,
  MoneyController,
  StorageController,
  ProcurementController,
  SalesController,
  KnittingController,
  SearchController,
  HealthController,
];
const publicRoutes = new Set(['/health', '/auth/login', '/auth/forgot-password', '/auth/refresh', '/auth/logout']);
const accessSecret = 'isolated-test-access-secret-with-at-least-32-characters';
const id = 'e831f989-1e07-4b62-894e-81d12c3d68ae';

const endpoints = controllers.flatMap((controller) => {
  const prefix = Reflect.getMetadata(PATH_METADATA, controller) as string;
  return Object.getOwnPropertyNames(controller.prototype).flatMap((name) => {
    const handler = (controller.prototype as unknown as Record<string, unknown>)[name];
    if (typeof handler !== 'function') return [];
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
    if (method === undefined) return [];
    const route = Reflect.getMetadata(PATH_METADATA, handler) as string;
    const url = `/${prefix}/${route}`.replace(/\/+$/, '').replace(/\/+/g, '/');
    const roles = (Reflect.getMetadata(ROLES_KEY, handler) ?? Reflect.getMetadata(ROLES_KEY, controller)) as Role[] | undefined;
    return [{ method: RequestMethod[method].toLowerCase(), url, roles }];
  });
});

describe('HTTP authentication and role boundaries (isolated service fixtures)', () => {
  let app: INestApplication;
  let origin: string;
  const jwt = new JwtService();
  const prisma = {
    user: {
      findUnique: jest.fn(({ where }: { where: { id: Role } }) =>
        Promise.resolve({ id: where.id, name: 'Test', email: 'test@example.com', role: where.id, status: 'ACTIVE' }),
      ),
    },
    refreshSession: {
      findUnique: jest.fn(({ where }: { where: { id: Role } }) =>
        Promise.resolve({ userId: where.id, revokedAt: null, expiresAt: new Date(Date.now() + 60000) }),
      ),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ ok: 1 }]),
  };
  const auth = {
    validateCredentials: jest.fn().mockRejectedValue(new UnauthorizedException('Invalid email or password')),
    refresh: jest.fn().mockRejectedValue(new UnauthorizedException('Refresh session expired')),
    revoke: jest.fn().mockResolvedValue(undefined),
    requestPasswordReset: jest.fn().mockResolvedValue(undefined),
    sessionIdOf: jest.fn(),
  };

  beforeAll(async () => {
    const config = new ConfigService({
      NODE_ENV: 'test',
      JWT_ACCESS_SECRET: accessSecret,
      JWT_REFRESH_SECRET: 'separate-test-refresh-secret-with-at-least-32-characters',
    });
    const dependencies = [
      ...new Set(
        controllers.flatMap((controller) => Reflect.getMetadata('design:paramtypes', controller) as Array<new (...args: any[]) => unknown>),
      ),
    ];
    const module = await Test.createTestingModule({
      imports: [PassportModule],
      controllers,
      providers: [
        ...dependencies.map((dependency) => ({
          provide: dependency,
          useValue: dependency === PrismaService ? prisma : dependency === ConfigService ? config : dependency === AuthService ? auth : {},
        })),
        { provide: ConfigService, useValue: config },
        JwtStrategy,
        RolesGuard,
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  const send = async (method: string, url: string, options: { token?: string; body?: unknown } = {}) => {
    const response = await fetch(`${origin}/api/v1${url.replace(/:[^/]+/g, id)}`, {
      method: method.toUpperCase(),
      headers: {
        ...(options.token ? { Cookie: `access_token=${options.token}` } : {}),
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    return {
      status: response.status,
      body: (await response.json()) as { success?: boolean; database?: string },
      cookies: response.headers.getSetCookie(),
    };
  };

  it('discovers the expected 152 controller endpoints', () => {
    expect(endpoints).toHaveLength(152);
  });

  it.each(endpoints.filter((endpoint) => !publicRoutes.has(endpoint.url)))(
    '$method $url rejects an absent session with 401',
    async ({ method, url }) => {
      const response = await send(method, url);
      expect(response.status).toBe(401);
    },
  );

  for (const role of Object.values(Role)) {
    it(`${role} receives 403 on every endpoint outside its declared permissions`, async () => {
      const token = jwt.sign(
        { sub: role, sid: role, email: 'test@example.com', name: 'Test', role },
        { secret: accessSecret, expiresIn: '1m' },
      );
      for (const endpoint of endpoints.filter((endpoint) => endpoint.roles && !endpoint.roles.includes(role))) {
        const response = await send(endpoint.method, endpoint.url, { token });
        expect({ endpoint: `${endpoint.method} ${endpoint.url}`, status: response.status }).toEqual({
          endpoint: `${endpoint.method} ${endpoint.url}`,
          status: 403,
        });
      }
    });
  }

  it('rejects malformed and expired access tokens with 401', async () => {
    const expired = jwt.sign({ sub: 'ADMIN' }, { secret: accessSecret, expiresIn: -1 });
    for (const token of ['invalid-token', expired]) expect((await send('get', '/auth/me', { token })).status).toBe(401);
  });

  it('validates login input and returns 401 for invalid credentials', async () => {
    expect((await send('post', '/auth/login', { body: {} })).status).toBe(400);
    expect((await send('post', '/auth/login', { body: { email: 'test@example.com', password: 'wrong-password' } })).status).toBe(401);
  });

  it('clears cookies after an invalid refresh and on logout', async () => {
    const refresh = await send('post', '/auth/refresh');
    expect(refresh.status).toBe(401);
    expect(refresh.cookies).toHaveLength(2);
    const logout = await send('post', '/auth/logout');
    expect(logout.status).toBe(201);
    expect(logout.cookies).toHaveLength(2);
  });

  it('keeps password reset responses generic', async () => {
    const response = await send('post', '/auth/forgot-password', { body: { email: 'unknown@example.com' } });
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });

  it('checks health without requiring authentication', async () => {
    const response = await send('get', '/health');
    expect(response.status).toBe(200);
    expect(response.body.database).toBe('connected');
  });
});
