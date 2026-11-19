import { BadRequestException } from '@nestjs/common';

const factoryCalendar = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
export const factoryToday = () => factoryCalendar.format(new Date());

/** Actual business dates, including earlier dates and equal-day hand-offs. Audit timestamps remain save times. */
export function businessDate(value: string | undefined, label: string, notBefore?: Date | null): Date {
  const text = value ?? factoryToday();
  const key = typeof text === 'string' ? text.slice(0, 10) : '';
  const parsed = new Date(`${key}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(key) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== key ||
    !Number.isFinite(new Date(text).getTime())
  ) {
    throw new BadRequestException(`${label}: choose a valid calendar date`);
  }
  if (key > factoryToday()) throw new BadRequestException(`${label} cannot be in the future`);
  if (notBefore && Number.isFinite(notBefore.getTime()) && key < notBefore.toISOString().slice(0, 10))
    throw new BadRequestException(`${label} cannot be before ${notBefore.toISOString().slice(0, 10)}`);
  return parsed;
}
