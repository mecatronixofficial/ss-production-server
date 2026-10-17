import { BadRequestException, Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Prisma, Role } from '@prisma/client';
import { AuthUser } from '../common/auth-user';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { PrismaService } from '../prisma/prisma.service';
import { CompanyProfileDto } from './company-settings.dto';

const COMPANY_KEY = 'company';
const COMPANY_DEFAULTS = { name: 'SS Clothing Mills', currency: 'INR', timezone: 'Asia/Kolkata' };

@Controller('admin')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(Role.SUPERADMIN, Role.ADMIN)
export class AdminController {
  constructor(private prisma: PrismaService) {}

  /** Company profile, merged over defaults, plus who saved it last. */
  @Get('settings/company')
  async company() {
    const [row, lastSave] = await Promise.all([
      this.prisma.systemSetting.findUnique({ where: { key: COMPANY_KEY } }),
      this.prisma.auditLog.findFirst({
        where: { action: 'SETTING_SAVED', entity: 'SystemSetting', newValue: { path: ['key'], equals: COMPANY_KEY } },
        orderBy: { createdAt: 'desc' },
        select: { actor: { select: { name: true } } },
      }),
    ]);
    const stored = row?.value && typeof row.value === 'object' && !Array.isArray(row.value) ? row.value : {};
    return {
      value: { ...COMPANY_DEFAULTS, ...stored },
      updatedAt: row?.updatedAt ?? null,
      updatedBy: lastSave?.actor?.name ?? null,
    };
  }

  @Put('settings/company')
  async saveCompany(@Body() body: CompanyProfileDto, @CurrentUser() user: AuthUser) {
    // The PAN is embedded in the GSTIN (characters 3–12), so the two must agree.
    if (body.gst && body.pan && body.gst.slice(2, 12) !== body.pan) {
      throw new BadRequestException('PAN does not match the PAN inside the GSTIN');
    }
    // Only defined fields are stored, so clearing a field removes it.
    const value = JSON.parse(JSON.stringify(body)) as Prisma.InputJsonObject;
    const saved = await this.prisma.$transaction(async (tx) => {
      const previous = await tx.systemSetting.findUnique({ where: { key: COMPANY_KEY } });
      const row = await tx.systemSetting.upsert({
        where: { key: COMPANY_KEY },
        create: { key: COMPANY_KEY, value },
        update: { value },
      });
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: 'SETTING_SAVED',
          module: 'admin',
          entity: 'SystemSetting',
          entityId: row.id,
          previousValue: previous?.value ?? Prisma.JsonNull,
          // `key` lets the settings page find who saved this setting last.
          newValue: { key: COMPANY_KEY, ...value },
        },
      });
      return row;
    });
    return { value: { ...COMPANY_DEFAULTS, ...value }, updatedAt: saved.updatedAt, updatedBy: user.name };
  }
}
