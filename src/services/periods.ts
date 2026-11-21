// ============================================================================
// Shared period service (D5): B.S. month periods, Gregorian ranges, and the
// configurable fiscal year. ALL calendar facts come from utils/nepaliDate
// (nepali-datetime lookup tables). The only date arithmetic here is plain
// A.D. (adding/subtracting whole days to an A.D. instant) — never B.S. math.
// ============================================================================
import { BS_MONTHS, SUPPORTED_BS_RANGE, bsToAD, getTodayBS, formatBS } from '../utils/nepaliDate';
import { readScoped } from './projectScope';

export const SETTINGS_KEY = 'contractoros_settings';

export interface BSPeriod {
  year: number;
  month: number; // 1-12
}

export interface FiscalYear {
  label: string; // "2083/84"
  startYear: number;
  startMonth: number; // 1-12 of start year
  endYear: number;
  endMonth: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Fiscal year start month (B.S., 1-12). Default = Baisakh (1). Reads app settings. */
export function fiscalYearStartMonth(): number {
  try {
    // The fiscal year is a book setting: each job carries its own.
    const settings = readScoped<{ fiscalYearStartMonth?: unknown }>(SETTINGS_KEY, {});
    const m = Number(settings?.fiscalYearStartMonth);
    if (Number.isInteger(m) && m >= 1 && m <= 12) return m;
  } catch {
    /* fall through to default */
  }
  return 1; // Baisakh
}

/** The fiscal year that contains the given B.S. year/month. */
export function fiscalYearOf(year: number, month: number): FiscalYear {
  const startMonth = fiscalYearStartMonth();
  const startYear = month >= startMonth ? year : year - 1;
  const endYear = startYear + 1;
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  const yy = (y: number) => String(y % 100).padStart(2, '0');
  return {
    label: `${startYear}/${yy(endYear)}`,
    startYear,
    startMonth,
    endYear,
    endMonth,
  };
}

/** Fiscal year of "today" (B.S., Kathmandu-anchored). */
export function currentFiscalYear(): FiscalYear {
  const t = getTodayBS();
  return fiscalYearOf(t.year, t.month);
}

/** Previous B.S. month (pure rollover via the library, no arithmetic tables). */
export function prevPeriod(p: BSPeriod): BSPeriod {
  return p.month === 1 ? { year: p.year - 1, month: 12 } : { year: p.year, month: p.month - 1 };
}

/** Next B.S. month. */
export function nextPeriod(p: BSPeriod): BSPeriod {
  return p.month === 12 ? { year: p.year + 1, month: 1 } : { year: p.year, month: p.month + 1 };
}

/**
 * Gregorian (A.D.) date range covered by a B.S. month:
 * first A.D. day of the month .. (first A.D. day of next month − 1 day).
 * Firsts-of-month come from bsToAD(); the −1 day is plain A.D. arithmetic.
 * Rendered in Asia/Kathmandu — toISOString() on a Kathmandu-midnight instant
 * would show the PREVIOUS UTC day (off-by-one).
 */
export function periodAdRange(p: BSPeriod): { from: string; to: string } {
  try {
    const from = bsToAD(p.year, p.month, 1);
    const nextFirst =
      p.month === 12 ? bsToAD(p.year + 1, 1, 1) : bsToAD(p.year, p.month + 1, 1);
    const to = new Date(nextFirst.getTime() - DAY_MS);
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kathmandu',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return { from: fmt.format(from), to: fmt.format(to) };
  } catch {
    // A stored period beyond B.S. 2100 has no A.D. range. Empty strings keep
    // callers total (adDateInPeriod simply matches nothing) instead of throwing.
    return { from: '', to: '' };
  }
}

/** Human period label: "Bhadra 2083 (AD 2026-08-17 → 2026-09-16)". */
export function periodLabel(p: BSPeriod): string {
  const name = BS_MONTHS[p.month - 1];
  const { from, to } = periodAdRange(p);
  if (!from || !to) {
    return `${name} ${p.year} — outside the supported calendar (${SUPPORTED_BS_RANGE})`;
  }
  return `${name} ${p.year} — AD ${from} → ${to}`;
}

/** B.S. period key used by locks ("2083-06"). */
export function periodKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** True when `dateISO` (A.D.) falls inside the given B.S. month's range. */
export function adDateInPeriod(dateISO: string, p: BSPeriod): boolean {
  const { from, to } = periodAdRange(p);
  const d = String(dateISO || '').slice(0, 10);
  return d >= from && d <= to;
}

/** B.S. date string "2083-06-23" from stored integers (CSV / display helper). */
export function bsIsoFromInts(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** "2082 Bhadra 27" style label for stored integers. */
export function bsLabelFromInts(y: number, m: number, d: number): string {
  return formatBS({ year: y, month: m, day: d }, { provisional: true });
}
