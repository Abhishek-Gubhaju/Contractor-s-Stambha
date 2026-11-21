// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  syncFromDSR,
  cumulativeDone,
  progressOf,
  statusFor,
  loadActivities,
  loadDependencies,
  slipDays,
  ganttListCsv,
  depPhrase,
  todayISO,
  addDaysISO,
  daysBetween,
  type Activity,
} from './dsrSyncService';

const BOQ = [
  {
    sectionCode: 'A',
    description: 'Earthworks',
    children: [
      { itemCode: 'A.01', description: 'Excavation', unit: 'm3', estimatedQuantity: 100, rate: 100 },
      { itemCode: 'A.02', description: 'Backfill', unit: 'm3', estimatedQuantity: 50, rate: 80 },
    ],
  },
];

const TODAY = todayISO();
const MILESTONES = [
  { id: 'm1', name: 'Foundation done', boqCode: 'A.01', startDate: addDaysISO(TODAY, -10), endDate: addDaysISO(TODAY, -5) },
  { id: 'm2', name: 'Backfill done', boqCode: 'A.02', startDate: addDaysISO(TODAY, -10), endDate: addDaysISO(TODAY, -5) },
];

function dsr(id: string, date: string, boqCode: string, workQuantity: number) {
  return { id, date, boqCode, workQuantity };
}

function sync(dsrData: any[], boqData: any[] = BOQ, milestones: any[] = MILESTONES) {
  return syncFromDSR({ dsrData, boqData, milestones, today: TODAY });
}

function actOf(acts: Activity[], code: string): Activity {
  const a = acts.find((x) => x.code === code && !x.is_milestone);
  if (!a) throw new Error(`no activity ${code}`);
  return a;
}

function msOf(acts: Activity[], msId: string): Activity {
  const a = acts.find((x) => x.id === `ms:${msId}`);
  if (!a) throw new Error(`no milestone ${msId}`);
  return a;
}

beforeEach(() => localStorage.clear());

describe('dsrSyncService — one-way DSR → Gantt contract (C)', () => {
  it('D0/C4: seeds the activities + dependencies tables with every Section D column', () => {
    const { activities, alerts } = sync([]);
    expect(activities).toHaveLength(4); // 2 BOQ items + 2 milestones
    expect(alerts).toEqual([]);
    const required = [
      'progress', 'status_cache', 'baseline_start', 'baseline_end',
      'actual_start', 'actual_finish', 'forecast_finish', 'synced_at', 'is_milestone',
    ];
    for (const a of activities) {
      for (const k of required) expect(a).toHaveProperty(k);
      // C6 snapshot: baseline equals planned at seed
      expect(a.baseline_start).toBe(a.start);
      expect(a.baseline_end).toBe(a.end);
    }
    expect(loadDependencies()).toHaveLength(3); // chain A.01→A.02, m1←A.01, m2←A.02
    expect(loadDependencies().every((d) => d.type === 'FS')).toBe(true);
  });

  it('F1: DSR qty derives progress/actual/forecast columns and persists them', () => {
    const { activities } = sync([dsr('d1', addDaysISO(TODAY, -8), 'A.01', 40)]);
    const a = actOf(activities, 'A.01');
    expect(a.progress).toBe(40); // 40/100
    expect(a.actual_start).toBe(addDaysISO(TODAY, -8));
    expect(a.actual_finish).toBeNull(); // still open
    expect(a.synced_at).toBeTruthy();
    // C4: columns are persisted for the Gantt to read — no DSR scan at render
    const stored = loadActivities().find((x) => x.id === 'act:A.01')!;
    expect(stored.progress).toBe(40);
    expect(stored.actual_start).toBe(addDaysISO(TODAY, -8));
    // case-insensitive DSR codes still aggregate (hand-typed codes)
    expect(cumulativeDone([dsr('x', TODAY, 'a.01', 40)], 'A.01')).toBe(40);
  });

  it('F3/C2: forecast = today + remaining/avg-daily-out; delayed status from C3', () => {
    const { activities, alerts } = sync([
      dsr('d1', addDaysISO(TODAY, -8), 'A.01', 20),
      dsr('d2', addDaysISO(TODAY, -6), 'A.01', 20),
    ]);
    const a = actOf(activities, 'A.01');
    // cumulative 40 over 2 worked days → avg 20/day; remaining 60 → +3 days
    expect(a.forecast_finish).toBe(addDaysISO(TODAY, 3));
    // planned end < today AND progress < 100 → delayed (red-hatch in UI)
    expect(a.status_cache).toBe('delayed');
    expect(a.end! < TODAY).toBe(true);
    // C5(c): forecast slip alert, red, no date changes
    const slip = alerts.find((x) => x.kind === 'forecast-slip')!;
    expect(slip.severity).toBe('red');
    expect(slip.message).toContain(`Forecast slip +${daysBetween(a.end!, a.forecast_finish!)}d`);
    expect(slip.message).toContain('no dates changed');
  });

  it('C3: status rules exactly as specified', () => {
    expect(statusFor({ progress: 100, start: TODAY, end: TODAY, actualStart: null, today: TODAY })).toBe('done');
    expect(statusFor({ progress: 40, start: addDaysISO(TODAY, -10), end: addDaysISO(TODAY, -5), actualStart: null, today: TODAY })).toBe('delayed');
    expect(statusFor({ progress: 10, start: addDaysISO(TODAY, -2), end: addDaysISO(TODAY, +2), actualStart: null, today: TODAY })).toBe('active'); // inside window
    expect(statusFor({ progress: 10, start: null, end: null, actualStart: addDaysISO(TODAY, -2), today: TODAY })).toBe('active'); // started, open
    expect(statusFor({ progress: 0, start: addDaysISO(TODAY, +3), end: addDaysISO(TODAY, +6), actualStart: null, today: TODAY })).toBe('planned');
  });

  it('F4: pushing the predecessor to 100% auto-flips the milestone with the actual date', () => {
    const { activities } = sync([dsr('d7', addDaysISO(TODAY, -7), 'A.01', 100)]);
    const pred = actOf(activities, 'A.01');
    expect(pred.progress).toBe(100);
    expect(pred.actual_finish).toBe(addDaysISO(TODAY, -7));
    expect(pred.status_cache).toBe('done');
    const m1 = msOf(activities, 'm1');
    expect(m1.progress).toBe(100);
    expect(m1.status_cache).toBe('done'); // the only auto-write, to Gantt's own table
    expect(m1.actual_finish).toBe(addDaysISO(TODAY, -7)); // DSR date last pred reached 100
    // unrelated milestone untouched
    const m2 = msOf(activities, 'm2');
    expect(m2.status_cache).not.toBe('done');
    expect(m2.actual_finish).toBeNull();
  });

  it('F2/C5(a): work before planned start raises an alert; removing the entry clears it', () => {
    const early = [dsr('e1', addDaysISO(TODAY, -20), 'A.01', 10)];
    const withEarly = sync(early);
    const alert = withEarly.alerts.find((x) => x.kind === 'early-dsr')!;
    expect(alert).toBeTruthy();
    expect(alert.message).toContain('before its planned start');
    expect(alert.activityId).toBe('act:A.01');
    const without = sync([]);
    expect(without.alerts.find((x) => x.kind === 'early-dsr')).toBeUndefined();
    // DSR dated on/after planned start → no early alert (F2 negative control)
    const onTime = sync([dsr('o1', addDaysISO(TODAY, -9), 'A.01', 10)]);
    expect(onTime.alerts.find((x) => x.kind === 'early-dsr')).toBeUndefined();
  });

  it('F7/C6: sync never modifies planned or baseline dates; slip = planned − baseline', () => {
    const first = sync([dsr('d1', addDaysISO(TODAY, -8), 'A.01', 40)]).activities;
    const before = first.map((a) => ({ id: a.id, start: a.start, end: a.end, bs: a.baseline_start, be: a.baseline_end }));
    const second = sync([dsr('d1', addDaysISO(TODAY, -8), 'A.01', 40), dsr('d2', TODAY, 'A.02', 5)]).activities;
    const after = second.map((a) => ({ id: a.id, start: a.start, end: a.end, bs: a.baseline_start, be: a.baseline_end }));
    expect(after).toEqual(before);
    for (const a of second) expect(slipDays(a)).toBe(0); // phase 1: baseline == planned at seed
    // a stored baseline in the past yields the documented slip diff
    expect(slipDays({ ...actOf(second, 'A.01'), end: addDaysISO(TODAY, 2) })).toBe(daysBetween(actOf(second, 'A.01').baseline_end!, addDaysISO(TODAY, 2)));
  });

  it('C4: derivation is idempotent (same inputs → same derived output)', () => {
    const input = [dsr('d1', addDaysISO(TODAY, -8), 'A.01', 40), dsr('d2', addDaysISO(TODAY, -7), 'A.01', 10)];
    const strip = (list: Activity[]) => list.map(({ synced_at, ...rest }) => rest);
    const run1 = sync(input).activities;
    const run2 = sync(input).activities;
    expect(strip(run2)).toEqual(strip(run1));
  });

  it('E1: cumulativeDone/progressOf are THE single aggregation rule', () => {
    const entries = [dsr('a', TODAY, 'A.01', 5), dsr('b', TODAY, 'A.01', 0), dsr('c', TODAY, 'A.01', 7)];
    expect(cumulativeDone(entries as any, 'A.01')).toBe(12);
    expect(cumulativeDone(entries as any, 'B.99')).toBe(0);
    expect(progressOf(12, 100)).toBe(12);
    expect(progressOf(105, 100)).toBe(105); // raw value; UI caps the bar
    expect(progressOf(10, 0)).toBe(0);
  });

  it('B5: dependency labels are plain language — never raw codes', () => {
    const { activities } = sync([]);
    const preds = loadDependencies().filter((d) => d.to_id === 'act:A.02');
    expect(preds).toHaveLength(1);
    expect(depPhrase(preds[0], activities)).toBe('after: Excavation');
    const base = { ...preds[0], type: 'SS' as const };
    expect(depPhrase(base, activities)).toBe('starts together with: Excavation');
    expect(depPhrase({ ...base, type: 'FF' as const }, activities)).toBe('finishes together with: Excavation');
    expect(depPhrase({ ...base, type: 'SF' as const }, activities)).toBe('finishes after the start of: Excavation');
    expect(depPhrase({ ...base, lag_days: 2 }, activities)).toBe('starts together with: Excavation + 2d');
    for (const t of ['FS', 'SS', 'FF', 'SF'] as const) {
      const phrase = depPhrase({ ...preds[0], type: t, lag_days: 3 }, activities);
      expect(phrase).not.toMatch(/:FS|:SS|:FF|:SF|FS\+|SS\+/);
    }
  });

  it('F9: list CSV includes bs_date, ad_date, progress and slip columns', () => {
    const { activities } = sync([dsr('d1', addDaysISO(TODAY, -8), 'A.01', 40)]);
    const csv = ganttListCsv(activities);
    const header = csv.split('\n')[0];
    for (const col of ['bs_date', 'ad_date', 'progress', 'slip_days']) expect(header).toContain(col);
    const a = actOf(activities, 'A.01');
    const row = csv.split('\n').find((r) => r.includes('"A.01"'))!;
    expect(row).toContain('"40"'); // progress
    expect(row).toContain(`"${a.end}"`); // ad_date
    expect(row).toMatch(/"\d{4}-\d{2}-\d{2}"/); // bs_date rendered
  });

  it('F1: milestone progress = min over predecessors while open', () => {
    const { activities } = sync([dsr('d1', addDaysISO(TODAY, -8), 'A.01', 40)]);
    const m1 = msOf(activities, 'm1');
    expect(m1.progress).toBe(40); // inherits predecessor progress
    expect(m1.actual_finish).toBeNull(); // not done yet
  });
});
