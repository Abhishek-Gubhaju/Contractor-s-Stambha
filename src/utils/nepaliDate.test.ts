// Acceptance checks A, B, D for the single-source B.S. date utility.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  BS_MONTHS,
  BS_MAX_YEAR,
  BS_MIN_YEAR,
  BS_PROVISIONAL_FROM_YEAR,
  SUPPORTED_BS_RANGE,
  adToBS,
  bsToAD,
  formatBS,
  formatBSFromAD,
  getTodayBS,
  isProvisionalBS,
  isSupportedBSYear,
  isSupportedDate,
  tryAdToBS,
  tryBsToAD,
} from './nepaliDate';

describe('A. known fixed conversions', () => {
  it('adToBS(2025-04-14) = {2082, 1, 1}', () => {
    expect(adToBS(new Date(2025, 3, 14))).toEqual({ year: 2082, month: 1, day: 1 });
  });

  it('adToBS(2024-04-13) = {2081, 1, 1}', () => {
    expect(adToBS(new Date(2024, 3, 13))).toEqual({ year: 2081, month: 1, day: 1 });
  });

  it('BS_MONTHS + formatBS produce "2082 Bhadra 27"', () => {
    expect(BS_MONTHS).toEqual([
      'Baisakh', 'Jestha', 'Ashadh', 'Shrawan', 'Bhadra', 'Ashwin',
      'Kartik', 'Mangsir', 'Poush', 'Magh', 'Falgun', 'Chaitra',
    ]);
    expect(formatBS({ year: 2082, month: 5, day: 27 })).toBe('2082 Bhadra 27');
  });

  it('getTodayBS() matches adToBS(now) and carries monthName', () => {
    const today = getTodayBS();
    const ad = adToBS(new Date());
    expect(today.year).toBe(ad.year);
    expect(today.month).toBe(ad.month);
    expect(today.day).toBe(ad.day);
    expect(today.monthName).toBe(BS_MONTHS[today.month - 1]);
  });

  // B.S. 2062 Baisakh has 31 days (Nepal Panchanga Nirnayak Samiti; ashesh.com.np
  // patro: 14 May 2005 = 2062/01/31). The previous table said 30 and was a day
  // early for 62 days — this pins the corrected reading.
  it('B.S. 2062 Baisakh is 31 days (errata fixed)', () => {
    expect(adToBS(new Date(2005, 4, 14))).toEqual({ year: 2062, month: 1, day: 31 });
    expect(adToBS(new Date(2005, 4, 15))).toEqual({ year: 2062, month: 2, day: 1 });
  });
});

describe('B. round trip for every day AD 2020-01-01 .. 2030-12-31', () => {
  it('bsToAD(adToBS(d)) equals d for all 4018 days', () => {
    let count = 0;
    const d = new Date(2020, 0, 1);
    const end = new Date(2030, 11, 31);
    while (d.getTime() <= end.getTime()) {
      const bs = adToBS(new Date(d.getTime()));
      const back = bsToAD(bs.year, bs.month, bs.day);
      if (back.getTime() !== d.getTime()) {
        throw new Error(
          `Round trip failed for ${d.toISOString()}: got ${back.toISOString()} (bs=${JSON.stringify(bs)})`,
        );
      }
      d.setDate(d.getDate() + 1);
      count += 1;
    }
    expect(count).toBe(4018);
  });
});

describe('C. B.S. calendar invariants', () => {
  const utcDay = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const monthStart = (year: number, month: number) => bsToAD(year, month, 1);
  const daysInMonth = (year: number, month: number) => {
    const next = month === 12 ? monthStart(year + 1, 1) : monthStart(year, month + 1);
    return (utcDay(next) - utcDay(monthStart(year, month))) / 86_400_000;
  };

  it('every B.S. month has 29-32 days', () => {
    for (let year = 2080; year <= 2085; year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        const days = daysInMonth(year, month);
        expect(days).toBeGreaterThanOrEqual(29);
        expect(days).toBeLessThanOrEqual(32);
      }
    }
  });

  it('the last day of each month converts back to that same B.S. day', () => {
    for (let year = 2080; year <= 2085; year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        const days = daysInMonth(year, month);
        const last = bsToAD(year, month, days);
        expect(adToBS(last)).toEqual({ year, month, day: days });
      }
    }
  });
});

describe('D. fully offline (no network APIs touched)', () => {
  it('all conversions succeed with fetch/XHR disabled', () => {
    const savedFetch = globalThis.fetch;
    const savedXHR = (globalThis as any).XMLHttpRequest;
    const blocked = () => {
      throw new Error('NETWORK CALL — date conversion must be offline');
    };
    (globalThis as any).fetch = blocked;
    (globalThis as any).XMLHttpRequest = class {
      constructor() {
        blocked();
      }
    };
    try {
      const today = getTodayBS();
      expect(today.monthName).toBe(BS_MONTHS[today.month - 1]);
      expect(adToBS(new Date(2025, 3, 14))).toEqual({ year: 2082, month: 1, day: 1 });
      expect(bsToAD(2082, 1, 1).getTime()).toBe(new Date(2025, 3, 14).getTime());
      expect(formatBS({ year: 2082, month: 1, day: 1 })).toBe('2082 Baisakh 1');
    } finally {
      (globalThis as any).fetch = savedFetch;
      (globalThis as any).XMLHttpRequest = savedXHR;
    }
  });

  it('the utility module source contains no network calls or remote URLs', () => {
    const src = readFileSync(new URL('./nepaliDate.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|https?:\/\//);
    // One MIT-licensed lookup-table library — and no GPL one, and no hand-copied
    // table (a vendored table would raise compilation/database-right questions).
    expect(src).toMatch(/from ['"]@inicrea\/bikram-sambat-core['"]/);
    expect(src).not.toContain('nepali-date-converter');
    expect(src).not.toContain('nepali-datetime');
  });
});

describe('E. supported range, refusals and provisional years', () => {
  it('exposes the range the engine actually covers', () => {
    expect(BS_MIN_YEAR).toBe(1975);
    expect(BS_MAX_YEAR).toBe(2100);
    expect(SUPPORTED_BS_RANGE).toContain('2044-04-12');
  });

  it('converts both ends of the range', () => {
    expect(adToBS(new Date(1918, 3, 13))).toEqual({ year: 1975, month: 1, day: 1 });
    expect(adToBS(new Date(2044, 3, 12))).toEqual({ year: 2100, month: 12, day: 30 });
    expect(bsToAD(1975, 1, 1).getTime()).toBe(new Date(1918, 3, 13).getTime());
    expect(bsToAD(2100, 12, 30).getTime()).toBe(new Date(2044, 3, 12).getTime());
  });

  it('refuses one day outside the range instead of returning a wrong date', () => {
    expect(() => adToBS(new Date(2044, 3, 13))).toThrow();
    expect(() => adToBS(new Date(1918, 3, 12))).toThrow();
    expect(() => bsToAD(1974, 12, 30)).toThrow();
    expect(() => bsToAD(2101, 1, 1)).toThrow();
  });

  it('the try* helpers return null so render paths never throw', () => {
    expect(tryAdToBS(new Date(2050, 0, 1))).toBeNull();
    expect(tryBsToAD(2107, 9, 1)).toBeNull();
    expect(tryAdToBS(new Date(2044, 3, 12))).toEqual({ year: 2100, month: 12, day: 30 });
    expect(formatBSFromAD(new Date(2050, 0, 1))).toBe('—');
    expect(formatBSFromAD(new Date(2025, 3, 14))).toBe('2082 Baisakh 1');
  });

  it('range predicates accept the edges and reject 2050 AD', () => {
    expect(isSupportedDate(new Date(1918, 3, 13))).toBe(true);
    expect(isSupportedDate(new Date(2044, 3, 12))).toBe(true);
    expect(isSupportedDate(new Date(2044, 3, 13))).toBe(false);
    expect(isSupportedDate(new Date(2050, 0, 1))).toBe(false);
    expect(isSupportedBSYear(1975)).toBe(true);
    expect(isSupportedBSYear(2100)).toBe(true);
    expect(isSupportedBSYear(2107)).toBe(false);
  });

  it('marks B.S. 2087+ as provisional and leaves settled years alone', () => {
    expect(isProvisionalBS({ year: BS_PROVISIONAL_FROM_YEAR - 1, month: 1, day: 1 })).toBe(false);
    expect(isProvisionalBS({ year: BS_PROVISIONAL_FROM_YEAR, month: 1, day: 1 })).toBe(true);
    expect(formatBS({ year: 2086, month: 1, day: 1 }, { provisional: true })).toBe('2086 Baisakh 1');
    expect(formatBS({ year: 2090, month: 1, day: 1 }, { provisional: true })).toBe(
      '2090 Baisakh 1 (provisional)',
    );
  });
});

describe('F. the notices that must ship with the installer', () => {
  const notices = readFileSync(new URL('../../THIRD-PARTY-NOTICES.txt', import.meta.url), 'utf8');

  it('names both copyright holders of the calendar data', () => {
    expect(notices).toContain('Inicrea Technologies');
    expect(notices).toContain('bs_calendar_core contributors');
    expect(notices).toContain('MIT');
  });

  it('no longer names the retired conversion library', () => {
    expect(notices).not.toContain('nepali-date-converter');
  });
});
