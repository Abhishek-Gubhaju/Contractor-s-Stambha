// ============================================================================
// ganttScale.ts — THE single scale function (B1, E1). Every x-position on the
// chart (bars, summary brackets, milestone diamonds, dependency arrows,
// gridlines, weekend shading, today line) goes through buildScale().x().
// Pure A.D. calendar math (UTC day offsets) — no B.S. arithmetic (A1).
// ============================================================================
import { DAY_MS } from './dsrSyncService';

export type Zoom = 'day' | 'week' | 'month' | 'fit';

/** Base column widths (px/day) for each zoom; fit is computed from width. */
export const ZOOM_COL_W: Record<Exclude<Zoom, 'fit'>, number> = {
  day: 32,
  week: 14,
  month: 7,
};

export interface Scale {
  minISO: string;
  maxISO: string;
  days: number;
  colW: number;
  width: number; // days * colW
  /** Left edge x of the day containing iso (clamped to the range). */
  x(iso: string | null | undefined): number;
  /** Center x of the day containing iso. */
  xCenter(iso: string | null | undefined): number;
  /** Day offset of iso from minISO. */
  dayIndex(iso: string): number;
  /** ISO of day offset i. */
  isoAt(index: number): string;
}

export function dayIndexFrom(minISO: string, iso: string): number {
  const a = Date.parse(`${minISO.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
  return Math.round((b - a) / DAY_MS);
}

export function buildScale(opts: { minISO: string; maxISO: string; colW: number }): Scale {
  const minISO = opts.minISO.slice(0, 10);
  const maxISO = opts.maxISO.slice(0, 10);
  const days = Math.max(1, dayIndexFrom(minISO, maxISO) + 1);
  const colW = Math.max(1, opts.colW); // honour fit widths down to 1px — do NOT re-clamp here
  const clampIdx = (i: number) => Math.min(Math.max(i, 0), days - 1);
  return {
    minISO,
    maxISO,
    days,
    colW,
    width: days * colW,
    dayIndex: (iso) => dayIndexFrom(minISO, iso),
    x: (iso) => (iso ? clampIdx(dayIndexFrom(minISO, iso)) * colW : 0),
    xCenter: (iso) => (iso ? clampIdx(dayIndexFrom(minISO, iso)) * colW + colW / 2 : 0),
    isoAt: (i) => new Date(Date.parse(`${minISO}T00:00:00Z`) + i * DAY_MS).toISOString().slice(0, 10),
  };
}

export function colWFor(zoom: Zoom, containerWidth: number, days: number): number {
  // Fit may go sub-4px for very long ranges — the whole point is that the
  // entire timeline is visible without horizontal scrolling (minimum 1px).
  if (zoom === 'fit') {
    // derive strictly from the measured container width (>=1px per day); a
    // hardcoded floor would make "Fit" overflow narrow containers.
    return Math.max(1, Math.floor(Math.max(0, containerWidth) / Math.max(1, days)));
  }
  return ZOOM_COL_W[zoom];
}

export interface MonthTick {
  label: string; // "Jan 2026"
  left: number;
  width: number;
  isFirst: boolean;
}

export function monthTicks(scale: Scale): MonthTick[] {
  const out: MonthTick[] = [];
  const start = new Date(`${scale.minISO}T00:00:00Z`);
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth();
  for (let guard = 0; guard < 600; guard++) {
    const first = new Date(Date.UTC(y, m, 1));
    const iso = first.toISOString().slice(0, 10);
    if (iso > scale.maxISO) break;
    const left = Math.max(0, scale.x(iso));
    const next = new Date(Date.UTC(y, m + 1, 1)).toISOString().slice(0, 10);
    const right = Math.min(scale.width, scale.x(next));
    if (right > 0 && left < scale.width) {
      out.push({
        label: first.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }),
        left,
        width: Math.max(1, right - left),
        isFirst: out.length === 0,
      });
    }
    y = first.getUTCMonth() === 11 ? first.getUTCFullYear() + 1 : y;
    m = (first.getUTCMonth() + 1) % 12;
  }
  return out;
}

/** Day ticks worth drawing for the current zoom (avoids DOM blowup at month zoom). */
export function dayTicks(scale: Scale): Array<{ iso: string; left: number; weekend: boolean; label: number; monthStart: boolean }> {
  const out: Array<{ iso: string; left: number; weekend: boolean; label: number; monthStart: boolean }> = [];
  for (let i = 0; i < scale.days; i++) {
    const iso = scale.isoAt(i);
    const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
    out.push({
      iso,
      left: i * scale.colW,
      weekend: dow === 0 || dow === 6,
      label: Number(iso.slice(8, 10)),
      monthStart: iso.slice(8, 10) === '01',
    });
  }
  return out;
}
