import { describe, it, expect } from 'vitest';
import { buildScale, colWFor, monthTicks, dayTicks, ZOOM_COL_W } from './ganttScale';
import { todayISO, addDaysISO, daysBetween } from './dsrSyncService';

describe('ganttScale — THE single scale function (B1/E1)', () => {
  it('x() is a shared, uniform mapping: every day is exactly colW apart', () => {
    const s = buildScale({ minISO: '2026-01-01', maxISO: '2026-01-31', colW: 14 });
    expect(s.days).toBe(31);
    expect(s.width).toBe(31 * 14);
    expect(s.x('2026-01-01')).toBe(0);
    expect(s.x('2026-01-15')).toBe(14 * 14);
    expect(s.x('2026-01-16') - s.x('2026-01-15')).toBe(14);
    // xCenter = left edge + half column, same function used by bars/diamonds/arrows
    expect(s.xCenter('2026-01-15')).toBe(s.x('2026-01-15') + 7);
    // out-of-range dates clamp — bars never escape the canvas
    expect(s.x('2020-05-05')).toBe(0);
    expect(s.x('2030-05-05')).toBe(30 * 14);
  });

  it('zooms map to fixed column widths; fit derives from container width (B2/F5)', () => {
    expect(ZOOM_COL_W.day).toBe(32);
    expect(ZOOM_COL_W.week).toBe(14);
    expect(ZOOM_COL_W.month).toBe(7);
    expect(colWFor('day', 800, 30)).toBe(32);
    expect(colWFor('week', 800, 30)).toBe(14);
    expect(colWFor('month', 800, 30)).toBe(7);
    expect(colWFor('fit', 800, 30)).toBe(Math.floor(800 / 30));
    // degenerate containers never produce a zero-width column
    expect(colWFor('fit', 1, 5000)).toBeGreaterThanOrEqual(1);
    expect(colWFor('fit', 100, 1)).toBe(100); // fit really fits a short range
  });

  it('F5: at every zoom the today line lands inside its exact day column', () => {
    const today = todayISO();
    const minISO = addDaysISO(today, -12);
    const maxISO = addDaysISO(today, 5);
    const days = daysBetween(minISO, maxISO) + 1;
    for (const zoom of ['day', 'week', 'month', 'fit'] as const) {
      const colW = colWFor(zoom, 580, days);
      const s = buildScale({ minISO, maxISO, colW });
      const left = s.x(today); // left edge of today's column
      expect(left % colW).toBe(0); // aligned to a whole column
      expect(s.isoAt(Math.floor(left / colW))).toBe(today); // column IS today
      // column center also maps back to today (diamonds/arrows stay aligned)
      expect(s.isoAt(Math.floor(s.xCenter(today) / colW))).toBe(today);
    }
  });

  it('monthTicks span the whole range with clamped edges', () => {
    const s = buildScale({ minISO: '2026-01-15', maxISO: '2026-04-05', colW: 10 });
    const ticks = monthTicks(s);
    expect(ticks[0].left).toBe(0); // partial first month clamps to 0
    expect(ticks[0].label).toContain('2026');
    expect(ticks[ticks.length - 1].label).toContain('Apr');
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i].left).toBeGreaterThan(ticks[i - 1].left);
    }
    expect(ticks[ticks.length - 1].left + ticks[ticks.length - 1].width).toBeLessThanOrEqual(s.width);
  });

  it('dayTicks flags weekends and labels the day of month', () => {
    const s = buildScale({ minISO: '2026-01-01', maxISO: '2026-01-07', colW: 8 });
    const ticks = dayTicks(s);
    expect(ticks).toHaveLength(7);
    expect(ticks[2].iso).toBe('2026-01-03'); // Saturday
    expect(ticks[2].weekend).toBe(true);
    expect(ticks[3].iso).toBe('2026-01-04'); // Sunday
    expect(ticks[3].weekend).toBe(true);
    expect(ticks[0].weekend).toBe(false);
    expect(ticks[0].label).toBe(1);
    expect(ticks[0].left).toBe(0);
    expect(ticks[1].left).toBe(8);
  });
});
