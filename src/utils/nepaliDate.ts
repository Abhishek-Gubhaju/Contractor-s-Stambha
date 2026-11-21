// ============================================================================
// Nepali (Bikram Sambat / B.S.) date utilities — SINGLE SOURCE OF TRUTH
// ----------------------------------------------------------------------------
// All B.S. <-> A.D. conversions in this app MUST go through this module.
// The calendar tables come from `@inicrea/bikram-sambat-core` (MIT licensed, so
// the app stays proprietary). Zero runtime dependencies and fully offline: no
// network call is made anywhere in this file.
//
// Supported range — the widest verified table that exists:
//   B.S. 1975/01/01 – 2100/12/30  =  A.D. 1918-04-13 – 2044-04-12
// The engine refuses anything outside it with a BikramRangeError instead of
// guessing, and the `try*` helpers here turn that refusal into null so a
// mistyped year can never blank a screen.
//
// B.S. 2087 and later is PROVISIONAL: Nepal's panchang is gazetted only a year
// or two ahead, so those years are projections that may still be corrected.
//
// Conventions used here:
//   - B.S. months are 1-12 (Baisakh = 1, Chaitra = 12) in the public API.
//   - "Today" is read in Asia/Kathmandu (UTC+05:45), so getTodayBS() always
//     reports the current day *in Nepal*, regardless of the machine's zone.
// ============================================================================

import { adToBs, bsToAdIso } from '@inicrea/bikram-sambat-core';

/** B.S. month names. Index 0 = Baisakh (month 1) ... index 11 = Chaitra (month 12). */
export const BS_MONTHS = [
  'Baisakh',
  'Jestha',
  'Ashadh',
  'Shrawan',
  'Bhadra',
  'Ashwin',
  'Kartik',
  'Mangsir',
  'Poush',
  'Magh',
  'Falgun',
  'Chaitra',
];

/** B.S. date: { year, month (1-12), day }. */
export type BSDay = { year: number; month: number; day: number };

/** Internal shape returned by getTodayBS(): BSDay + monthName. */
type BSToday = BSDay & { monthName: string };

/** First and last B.S. year the calendar table covers. */
export const BS_MIN_YEAR = 1975;
export const BS_MAX_YEAR = 2100;

/** The same range as A.D. calendar days (inclusive). */
export const BS_AD_MIN = '1918-04-13';
export const BS_AD_MAX = '2044-04-12';

/** Human-readable range for messages shown to people. */
export const SUPPORTED_BS_RANGE = 'B.S. 1975–2100 (A.D. 1918-04-13 – 2044-04-12)';

/** First B.S. year whose month lengths are still provisional, not gazetted. */
export const BS_PROVISIONAL_FROM_YEAR = 2087;

/** Shown in place of a B.S. date that cannot be produced. */
export const BS_UNAVAILABLE = '—';

/** The app's calendar home: B.S. days are the days people live through there. */
const KATHMANDU = 'Asia/Kathmandu';

const pad = (value: number, width: number) => String(value).padStart(width, '0');

/** Local calendar day of an instant, as the "YYYY-MM-DD" string the engine takes. */
function isoDay(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}

/** The calendar day (month 1-12) that an instant falls on in `timeZone`. */
function calendarDayIn(date: Date, timeZone: string): BSDay {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: read('year'), month: read('month'), day: read('day') };
}

/** True when this A.D. day has a B.S. equivalent in the bundled table. */
export function isSupportedDate(date: Date): boolean {
  const iso = isoDay(date);
  return iso >= BS_AD_MIN && iso <= BS_AD_MAX;
}

/** True when a B.S. year is inside the bundled table. */
export function isSupportedBSYear(year: number): boolean {
  return Number.isInteger(year) && year >= BS_MIN_YEAR && year <= BS_MAX_YEAR;
}

/** True when a B.S. date is later than the last gazetted year. */
export function isProvisionalBS(date: BSDay): boolean {
  return date.year >= BS_PROVISIONAL_FROM_YEAR;
}

/**
 * Today's B.S. date, read from the current time (Asia/Kathmandu-anchored).
 * Returns { year, month (1-12), day, monthName }.
 */
export function getTodayBS(): BSToday {
  // Read "today" in Nepal first, so a machine west of UTC+05:45 never reports
  // yesterday's date between local midnight and Kathmandu midnight.
  const kathmandu = calendarDayIn(new Date(), KATHMANDU);
  const bs = adToBS(new Date(kathmandu.year, kathmandu.month - 1, kathmandu.day));
  return { ...bs, monthName: BS_MONTHS[bs.month - 1] };
}

/**
 * Convert an A.D. (Gregorian) Date to its B.S. equivalent: { year, month (1-12), day }.
 * Throws BikramRangeError outside A.D. 1918-04-13 .. 2044-04-12.
 */
export function adToBS(adDate: Date): BSDay {
  // Read the Date's local calendar components: a calendar date is not an
  // instant, and the engine takes "YYYY-MM-DD" so no time-of-day can shift it.
  const bs = adToBs(isoDay(adDate));
  return {
    year: bs.year,
    month: bs.month,
    day: bs.day,
  };
}

/**
 * Convert a B.S. date (month 1-12) back to a JS Date (A.D., local midnight).
 * Throws BikramRangeError outside B.S. 1975/01/01 .. 2100/12/30.
 */
export function bsToAD(year: number, month: number, day: number): Date {
  const iso = bsToAdIso({ year, month, day });
  const [y, m, d] = iso.split('-').map(Number);
  // Build the date from its own components: parsing the string would be UTC.
  return new Date(y, m - 1, d);
}

/** adToBS() that returns null instead of throwing (safe in render paths). */
export function tryAdToBS(adDate: Date): BSDay | null {
  try {
    return adToBS(adDate);
  } catch {
    return null;
  }
}

/** bsToAD() that returns null instead of throwing (safe in render paths). */
export function tryBsToAD(year: number, month: number, day: number): Date | null {
  try {
    return bsToAD(year, month, day);
  } catch {
    return null;
  }
}

/**
 * Format a B.S. date as e.g. "2082 Bhadra 27".
 * Pass { provisional: true } to append "(provisional)" for B.S. 2087+.
 */
export function formatBS(date: BSDay, options?: { provisional?: boolean }): string {
  const base = `${date.year} ${BS_MONTHS[date.month - 1]} ${date.day}`;
  return options?.provisional && isProvisionalBS(date) ? `${base} (provisional)` : base;
}

/** Format an A.D. date as a B.S. label, or "—" when it is outside the table. */
export function formatBSFromAD(adDate: Date): string {
  const bs = tryAdToBS(adDate);
  return bs ? formatBS(bs) : BS_UNAVAILABLE;
}
