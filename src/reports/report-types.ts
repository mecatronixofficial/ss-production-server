/** How a value is shown on screen and formatted in Excel / PDF. */
export type ColumnType = 'text' | 'date' | 'status' | 'kg' | 'qty' | 'money' | 'number' | 'pct';

export type ReportColumn = {
  key: string;
  label: string;
  type: ColumnType;
  /** Adds the column to the totals row. */
  total?: boolean;
};

export type ReportSummaryItem = { label: string; value: number | string; type: ColumnType; hint?: string };

export type ReportRow = Record<string, string | number | null>;

export type ReportGroup = 'Overview' | 'Sales' | 'Production' | 'Purchases' | 'Inventory' | 'Machines' | 'Finance';

export type DateRange = { from?: Date; to?: Date };

export type ReportBody = {
  columns: ReportColumn[];
  rows: ReportRow[];
  summary: ReportSummaryItem[];
  /** Extra context shown under the table, e.g. how a figure is calculated. */
  note?: string;
  truncated?: boolean;
};

export type ReportDefinition = {
  key: string;
  title: string;
  group: ReportGroup;
  description: string;
  /** What the date filter applies to; null when the report is always "as of today". */
  dateLabel: string | null;
  build: (range: DateRange, ctx: ReportContext) => Promise<ReportBody>;
};

export type ReportContext = { timezone: string; now: Date };

export type ReportResult = ReportBody & {
  key: string;
  title: string;
  group: ReportGroup;
  description: string;
  dateLabel: string | null;
  from: string | null;
  to: string | null;
  totals: Record<string, number>;
  generatedAt: string;
  company: CompanyHeader;
};

export type CompanyHeader = { name: string; gst?: string; address?: string; timezone: string };

/** Rows returned per report; the result says when it was cut short. */
export const ROW_LIMIT = 5000;

export const num = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));
export const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;
export const pct = (part: number, whole: number) => (whole > 0 ? round((part / whole) * 100, 1) : 0);
export const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);

/** Prisma date filter for a half-open range [from, to). */
export const between = (range: DateRange) =>
  range.from || range.to ? { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lt: range.to } : {}) } : undefined;

export function limit<T>(rows: T[]) {
  return rows.length > ROW_LIMIT ? { rows: rows.slice(0, ROW_LIMIT), truncated: true } : { rows, truncated: false };
}

/** yyyy-mm in the company's time zone. */
export function monthKey(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit' }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}`;
}

export function monthLabel(key: string) {
  const [year, month] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}
