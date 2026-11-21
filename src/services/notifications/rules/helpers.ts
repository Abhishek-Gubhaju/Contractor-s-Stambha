// Small date/number helpers shared by the pure rules. No clock, no storage.
import { formatCurrency } from '../../../utils';

export const DAY_MS = 24 * 60 * 60 * 1000;

export function isIsoDate(value: unknown): value is string {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''));
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: unknown, to: unknown): number | null {
  if (!isIsoDate(from) || !isIsoDate(to)) return null;
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round((end - start) / DAY_MS);
}

/** Shift a YYYY-MM-DD date by whole days, in UTC (no DST surprises). */
export function addDaysIso(date: string, days: number): string | null {
  if (!isIsoDate(date)) return null;
  const t = Date.parse(`${date}T00:00:00Z`) + days * DAY_MS;
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

export function quantity(value: unknown): string {
  const n = Number(value) || 0;
  return String(Math.round(n * 100) / 100);
}

export function money(value: unknown): string {
  return formatCurrency(Number(value) || 0);
}

export function percent(done: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.round((done / total) * 100);
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** Rule key: `rule|project|entity|bucket` — stable and human-debuggable. */
export function notificationKey(rule: string, projectId: string, entity: string, bucket = 'open'): string {
  return [rule, projectId || 'job', entity || 'all', bucket].join('|');
}
