import { Injectable, NotFoundException } from '@nestjs/common';
import { MoneyService } from '../finance/money.service';
import { PrismaService } from '../prisma/prisma.service';
import { reportDefinitions } from './report-definitions';
import { toExcel, toPdf } from './report-export';
import { CompanyHeader, DateRange, num, ReportDefinition, ReportResult, round } from './report-types';

const DEFAULT_TIMEZONE = 'Asia/Kolkata';

@Injectable()
export class ReportsService {
  private readonly definitions: ReportDefinition[];

  constructor(
    private prisma: PrismaService,
    money: MoneyService,
  ) {
    this.definitions = reportDefinitions(prisma, money);
  }

  /** Report list for the sidebar: no data, just what each report is. */
  catalog() {
    return this.definitions.map(({ key, title, group, description, dateLabel }) => ({ key, title, group, description, dateLabel }));
  }

  /** Company name and time zone from Settings, used on exports and for month / date boundaries. */
  private async company(): Promise<CompanyHeader> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: 'company' } });
    const value = (row?.value && typeof row.value === 'object' && !Array.isArray(row.value) ? row.value : {}) as Record<string, unknown>;
    const str = (key: string) => {
      const v = value[key];
      return typeof v === 'string' && v ? v : undefined;
    };
    const address = [str('address'), str('city'), [str('state'), str('pincode')].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    return {
      name: str('name') ?? 'SS Clothing Mills',
      gst: str('gst'),
      address: address || undefined,
      timezone: str('timezone') ?? DEFAULT_TIMEZONE,
    };
  }

  async run(key: string, range: DateRange): Promise<ReportResult> {
    const definition = this.definitions.find((d) => d.key === key);
    if (!definition) throw new NotFoundException('Report not found');
    const company = await this.company();
    const now = new Date();
    // "As of today" reports ignore the date filter.
    const effective = definition.dateLabel === null ? {} : range;
    const body = await definition.build(effective, { timezone: company.timezone, now });
    const totals: Record<string, number> = {};
    for (const column of body.columns.filter((c) => c.total)) {
      const digits = column.type === 'money' ? 2 : 3;
      totals[column.key] = round(
        body.rows.reduce((sum, row) => sum + num(row[column.key]), 0),
        digits,
      );
    }
    return {
      ...body,
      key: definition.key,
      title: definition.title,
      group: definition.group,
      description: definition.description,
      dateLabel: definition.dateLabel,
      from: effective.from?.toISOString() ?? null,
      to: effective.to?.toISOString() ?? null,
      totals,
      truncated: body.truncated ?? false,
      generatedAt: now.toISOString(),
      company,
    };
  }

  async excel(key: string, range: DateRange) {
    return toExcel(await this.run(key, range));
  }

  async pdf(key: string, range: DateRange) {
    return toPdf(await this.run(key, range));
  }
}
