import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Prisma, Role } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { PrismaService } from '../prisma/prisma.service';

/** Pseudo actor id for events recorded without a user (background jobs, older records). */
const SYSTEM = 'system';
const EXPORT_LIMIT = 5000;
/** Modules whose events concern sign-in, accounts and configuration. */
const SECURITY_MODULES = ['auth', 'users', 'admin'];

class AuditFilterDto {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsString() @MaxLength(40) module?: string;
  @IsOptional() @IsString() @MaxLength(60) action?: string;
  @IsOptional()
  @Matches(/^(system|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i, { message: 'actorId must be a user id or "system"' })
  actorId?: string;
  /** Inclusive lower bound (ISO timestamp; the client sends local start-of-day). */
  @IsOptional() @IsDateString() from?: string;
  /** Exclusive upper bound. */
  @IsOptional() @IsDateString() to?: string;
}

class AuditListDto extends AuditFilterDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 25;
}

const actorSelect = { select: { id: true, name: true, email: true } } as const;

function whereFor(f: AuditFilterDto): Prisma.AuditLogWhereInput {
  const q = f.q?.trim();
  return {
    ...(f.module ? { module: f.module } : {}),
    ...(f.action ? { action: f.action } : {}),
    ...(f.actorId ? { actorId: f.actorId === SYSTEM ? null : f.actorId } : {}),
    ...(f.from || f.to ? { createdAt: { ...(f.from ? { gte: new Date(f.from) } : {}), ...(f.to ? { lt: new Date(f.to) } : {}) } } : {}),
    ...(q
      ? {
          OR: [
            { action: { contains: q.replace(/\s+/g, '_'), mode: 'insensitive' } },
            { module: { contains: q, mode: 'insensitive' } },
            { entity: { contains: q, mode: 'insensitive' } },
            { entityId: { contains: q, mode: 'insensitive' } },
            { ipAddress: { contains: q } },
            { actor: { name: { contains: q, mode: 'insensitive' } } },
            { actor: { email: { contains: q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };
}

/** CSV cell: quoted, and neutralised if a spreadsheet could read it as a formula. */
function csvCell(value: unknown) {
  let text = value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

@Controller('admin/audit-logs')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(Role.SUPERADMIN, Role.ADMIN)
export class AuditLogsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async list(@Query() query: AuditListDto) {
    const where = whereFor(query);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        include: { actor: actorSelect },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  /** Options for the filter menus plus headline counts. `since` values come from the client so "today" follows its time zone. */
  @Get('summary')
  async summary(@Query('todayStart') todayStart?: string, @Query('weekStart') weekStart?: string) {
    const since = (value?: string) => (value && !Number.isNaN(Date.parse(value)) ? new Date(value) : undefined);
    const today = since(todayStart);
    const week = since(weekStart);
    const [total, todayCount, weekCount, security, modules, actions, actorIds, systemCount] = await Promise.all([
      this.prisma.auditLog.count(),
      today ? this.prisma.auditLog.count({ where: { createdAt: { gte: today } } }) : Promise.resolve(0),
      week ? this.prisma.auditLog.count({ where: { createdAt: { gte: week } } }) : Promise.resolve(0),
      this.prisma.auditLog.count({ where: { module: { in: SECURITY_MODULES } } }),
      this.prisma.auditLog.groupBy({ by: ['module'], _count: { _all: true }, orderBy: { module: 'asc' } }),
      this.prisma.auditLog.groupBy({ by: ['action'], orderBy: { action: 'asc' } }),
      this.prisma.auditLog.groupBy({ by: ['actorId'], where: { actorId: { not: null } } }),
      this.prisma.auditLog.count({ where: { actorId: null } }),
    ]);
    const actors = await this.prisma.user.findMany({
      where: { id: { in: actorIds.map((a) => a.actorId!).filter(Boolean) } },
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
    });
    return {
      counts: { total, today: todayCount, last7Days: weekCount, security },
      modules: modules.map((m) => ({ module: m.module, count: m._count._all })),
      actions: actions.map((a) => a.action),
      actors,
      hasSystemEvents: systemCount > 0,
    };
  }

  @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="audit-log.csv"')
  async export(@Query() query: AuditFilterDto) {
    const rows = await this.prisma.auditLog.findMany({
      where: whereFor(query),
      include: { actor: actorSelect },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: EXPORT_LIMIT,
    });
    const header = ['Time (UTC)', 'User', 'Email', 'Action', 'Module', 'Entity', 'Entity ID', 'IP address', 'Before', 'After'];
    const lines = rows.map((r) =>
      [
        r.createdAt.toISOString(),
        r.actor?.name ?? 'System',
        r.actor?.email ?? '',
        r.action,
        r.module,
        r.entity,
        r.entityId,
        r.ipAddress,
        r.previousValue,
        r.newValue,
      ]
        .map(csvCell)
        .join(','),
    );
    // BOM so Excel opens the file as UTF-8.
    return '﻿' + [header.map(csvCell).join(','), ...lines].join('\r\n');
  }
}
