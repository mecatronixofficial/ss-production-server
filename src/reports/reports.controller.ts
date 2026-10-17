import { BadRequestException, Controller, Get, Param, Query, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Role } from '@prisma/client';
import { IsDateString, IsOptional } from 'class-validator';
import { Response } from 'express';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { ReportsService } from './reports.service';

class ReportRangeDto {
  /** Inclusive start (ISO timestamp; the client sends local start-of-day). */
  @IsOptional() @IsDateString() from?: string;
  /** Exclusive end. */
  @IsOptional() @IsDateString() to?: string;
}

const toRange = (q: ReportRangeDto) => {
  const range = { from: q.from ? new Date(q.from) : undefined, to: q.to ? new Date(q.to) : undefined };
  if (range.from && range.to && range.from >= range.to) throw new BadRequestException('The start date must be before the end date');
  return range;
};
const fileName = (key: string, ext: string) => `${key}-report-${new Date().toISOString().slice(0, 10)}.${ext}`;

@Controller('reports')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(Role.SUPERADMIN, Role.ADMIN)
export class ReportsController {
  constructor(private s: ReportsService) {}

  @Get()
  catalog() {
    return this.s.catalog();
  }

  @Get(':key')
  report(@Param('key') key: string, @Query() query: ReportRangeDto) {
    return this.s.run(key, toRange(query));
  }

  @Get(':key/export.xlsx')
  async excel(@Param('key') key: string, @Query() query: ReportRangeDto, @Res({ passthrough: true }) res: Response) {
    const file = await this.s.excel(key, toRange(query));
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${fileName(key, 'xlsx')}"`,
    });
    return new StreamableFile(file);
  }

  @Get(':key/export.pdf')
  async pdf(@Param('key') key: string, @Query() query: ReportRangeDto, @Res({ passthrough: true }) res: Response) {
    const file = await this.s.pdf(key, toRange(query));
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${fileName(key, 'pdf')}"` });
    return new StreamableFile(file);
  }
}
