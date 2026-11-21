// ============================================================================
// dsrSyncService — ONE-WAY sync contract: DSR → (shared aggregation) → Gantt.
// Gantt NEVER writes to DSR (C1). The only writes here are to the Gantt
// activities table itself (derived columns + milestone auto-flip, C4/C5).
//
// • Single aggregation path (E1): cumulativeDone()/progressOf() are THE rule;
//   Work Progress and Gantt both call them (no second aggregation).
// • Idempotent: derived columns are recomputed from source data every run.
// • Dates: canonical AD strings in; derived AD dates out; today comes from
//   utils/nepaliDate (A1). Plain A.D. day arithmetic only — no B.S. math.
// ============================================================================
import { getTodayBS, adToBS, bsToAD, formatBS, tryAdToBS } from '../utils/nepaliDate';
import { readScoped, writeScoped } from './projectScope';
import { dsrLines } from './dsrService';

export const ACTIVITIES_KEY = 'contractoros_gantt_activities';
export const DEPS_KEY = 'contractoros_gantt_dependencies';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Section D: activities table. */
export interface Activity {
  id: string;
  code: string;
  name: string;
  sector: string;
  start: string | null; // planned start (AD ISO)
  end: string | null; // planned end (AD ISO)
  progress: number; // derived: cumulative done qty / BOQ qty (%)
  status_cache: 'done' | 'delayed' | 'active' | 'planned';
  baseline_start: string | null; // snapshot (C6) — never auto-modified
  baseline_end: string | null;
  actual_start: string | null; // derived (C2)
  actual_finish: string | null;
  forecast_finish: string | null;
  is_milestone: boolean;
  synced_at: string | null;
}

export type DepType = 'FS' | 'SS' | 'FF' | 'SF';

/** Section D: dependencies table. */
export interface Dependency {
  id: string;
  from_id: string;
  to_id: string;
  type: DepType;
  lag_days: number;
}

export interface DsrRecord {
  id: string;
  date: string;
  boqCode: string;
  workQuantity: number;
  [k: string]: unknown;
}

export interface SyncAlert {
  id: string;
  kind: 'early-dsr' | 'stale-active' | 'forecast-slip';
  severity: 'red' | 'amber';
  activityId: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Shared aggregation (the Work Progress rule, in one place)
// ---------------------------------------------------------------------------
/** Case-insensitive BOQ-code comparison — DSR codes are hand-typed. */
export function sameCode(a?: string | null, b?: string | null): boolean {
  return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}

/**
 * Σ quantity reported for a BOQ code. Delegates to the shared rule so a
 * multi-item daily report counts exactly like the old single-line records.
 */
export function cumulativeDone(dsrData: DsrRecord[], boqCode: string): number {
  // dsrLines() migrates legacy records on the fly, so this one path is exact
  // for both old single-line rows and new multi-item reports.
  const total = dsrLines(dsrData as any[])
    .filter((l) => sameCode(l.boqCode, boqCode) && l.quantity > 0)
    .reduce((s, l) => s + l.quantity, 0);
  return Math.round(total * 100) / 100;
}

/** progress % = cumulative done / BOQ qty (raw, 2dp; UI may cap the bar). */
export function progressOf(cumulative: number, boqQty: number): number {
  if (!(boqQty > 0)) return 0;
  return Math.round((cumulative / boqQty) * 10000) / 100;
}

// ---------------------------------------------------------------------------
// Today (A1/A2): getTodayBS() resolved to its A.D. calendar day
// ---------------------------------------------------------------------------
function isoInKathmandu(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kathmandu',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export function todayISO(): string {
  const t = getTodayBS();
  return isoInKathmandu(bsToAD(t.year, t.month, t.day));
}

export function addDaysISO(iso: string, days: number): string {
  const t = Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`) + days * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

export function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.parse(`${String(fromISO).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(toISO).slice(0, 10)}T00:00:00Z`);
  return Math.round((b - a) / DAY_MS);
}

/** Weekday-only working days between dates (Mon–Fri). No holiday calendar (E4). */
export function workingDaysBetween(fromISO: string, toISO: string): number {
  let n = 0;
  let cur = Date.parse(`${String(fromISO).slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${String(toISO).slice(0, 10)}T00:00:00Z`);
  while (cur <= end) {
    const dow = new Date(cur).getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
    cur += DAY_MS;
  }
  return Math.max(0, n - 1); // count of working days strictly after `from`
}

// ---------------------------------------------------------------------------
// Store + migration (derived + baseline columns)
// ---------------------------------------------------------------------------
function read<T>(key: string, fallback: T): T {
  // Activities and dependencies belong to the active project.
  return readScoped<T>(key, fallback);
}

function write(key: string, value: unknown) {
  writeScoped(key, value);
}

function emitChange() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('contractoros:gantt-synced'));
  }
}

export function loadActivities(): Activity[] {
  return read<Activity[]>(ACTIVITIES_KEY, []);
}

export function loadDependencies(): Dependency[] {
  return read<Dependency[]>(DEPS_KEY, []);
}

export function saveActivities(list: Activity[]) {
  write(ACTIVITIES_KEY, list);
}

export function saveDependencies(list: Dependency[]) {
  write(DEPS_KEY, list);
}

const DEFAULT_COLS: Pick<
  Activity,
  'progress' | 'status_cache' | 'actual_start' | 'actual_finish' | 'forecast_finish' | 'synced_at'
> = {
  progress: 0,
  status_cache: 'planned',
  actual_start: null,
  actual_finish: null,
  forecast_finish: null,
  synced_at: null,
};

/** Top-up any activity row missing Section D columns (migration). */
export function migrateActivityRows(rows: any[]): Activity[] {
  return rows.filter(Boolean).map((r) => {
    const start = r.start ?? null;
    const end = r.end ?? null;
    return {
      id: String(r.id),
      code: String(r.code ?? ''),
      name: String(r.name ?? ''),
      sector: String(r.sector ?? ''),
      start,
      end,
      baseline_start: r.baseline_start !== undefined ? r.baseline_start : start, // C6 snapshot
      baseline_end: r.baseline_end !== undefined ? r.baseline_end : end,
      is_milestone: Boolean(r.is_milestone),
      ...DEFAULT_COLS,
      progress: Number(r.progress) || 0,
      status_cache: r.status_cache ?? 'planned',
      actual_start: r.actual_start ?? null,
      actual_finish: r.actual_finish ?? null,
      forecast_finish: r.forecast_finish ?? null,
      synced_at: r.synced_at ?? null,
    } as Activity;
  });
}

interface SeedContext {
  boqData: any[];
  milestones: any[];
}

function projectWindow(ctx: SeedContext): { min: string; max: string } {
  const msDates = ctx.milestones.flatMap((m: any) => [m.startDate, m.endDate]).filter(Boolean).sort();
  if (msDates.length) return { min: msDates[0], max: msDates[msDates.length - 1] };
  const t = todayISO();
  return { min: addDaysISO(t, -30), max: addDaysISO(t, 30) };
}

/**
 * Seed / migrate the activities + dependencies tables from BOQ + Work Progress
 * milestones (additive only — existing planned/baseline dates are never
 * modified once stored, C6/E).
 */
export function ensureStore(ctx: SeedContext): { activities: Activity[]; dependencies: Dependency[] } {
  const win = projectWindow(ctx);
  const boqItems: any[] = (ctx.boqData || []).flatMap((s: any) =>
    (s.children || []).map((item: any) => ({ ...item, sector: s.description || s.sectionCode || '' }))
  );
  let activities = migrateActivityRows(read<any[]>(ACTIVITIES_KEY, []));
  const existingIds = new Set(activities.map((a) => a.id));
  const byId = new Map(activities.map((a) => [a.id, a] as const));

  // 1) BOQ-item activities (planned window = milestone covering the code, else project window)
  for (const item of boqItems) {
    const id = `act:${item.itemCode}`;
    if (existingIds.has(id)) continue; // additive only
    const ms = (ctx.milestones || []).find((m: any) => String(m.boqCode).toLowerCase() === String(item.itemCode).toLowerCase());
    const start = ms ? ms.startDate : win.min;
    const end = ms ? ms.endDate : win.max;
    activities.push({
      id,
      code: item.itemCode,
      name: item.description || item.itemCode,
      sector: item.sector,
      start,
      end,
      baseline_start: start, // phase-1 snapshot = planned at seed
      baseline_end: end,
      ...DEFAULT_COLS,
      is_milestone: false,
    } as Activity);
    existingIds.add(id);
    byId.set(id, activities[activities.length - 1]);
  }

  // 2) Milestone activities (diamonds at their target date)
  for (const m of ctx.milestones || []) {
    const id = `ms:${m.id}`;
    if (existingIds.has(id)) continue;
    const section = (ctx.boqData || []).find((s: any) =>
      (s.children || []).some((c: any) => String(c.itemCode).toLowerCase() === String(m.boqCode || '').toLowerCase())
    );
    activities.push({
      id,
      code: String(m.boqCode || ''),
      name: m.name,
      sector: section ? section.description : 'Milestone',
      start: m.startDate || m.endDate || win.min,
      end: m.endDate || m.startDate || win.max,
      baseline_start: m.startDate || null,
      baseline_end: m.endDate || null,
      ...DEFAULT_COLS,
      is_milestone: true,
    } as Activity);
    existingIds.add(id);
    byId.set(id, activities[activities.length - 1]);
  }

  activities.sort((a, b) => {
    const sa = a.sector.localeCompare(b.sector);
    if (sa !== 0) return sa;
    if (a.is_milestone !== b.is_milestone) return a.is_milestone ? 1 : -1;
    return String(a.start).localeCompare(String(b.start));
  });

  // 3) Dependencies: sequential FS within + across sectors; milestone ← its BOQ activity
  let deps = read<Dependency[]>(DEPS_KEY, []);
  if (deps.length === 0) {
    const chain = activities.filter((a) => !a.is_milestone);
    for (let i = 1; i < chain.length; i++) {
      deps.push({ id: `dep:${chain[i - 1].id}->${chain[i].id}`, from_id: chain[i - 1].id, to_id: chain[i].id, type: 'FS', lag_days: 0 });
    }
    for (const ms of activities.filter((a) => a.is_milestone)) {
      const pred = activities.find((a) => !a.is_milestone && a.code && a.code === ms.code);
      const target = pred || [...chain].reverse().find((a) => String(a.end) <= String(ms.end));
      if (target) {
        deps.push({ id: `dep:${target.id}->${ms.id}`, from_id: target.id, to_id: ms.id, type: 'FS', lag_days: 0 });
      }
    }
    write(DEPS_KEY, deps);
  }

  saveActivities(activities);
  return { activities, dependencies: deps };
}

// ---------------------------------------------------------------------------
// Status rules (C3)
// ---------------------------------------------------------------------------
export function statusFor(input: {
  progress: number;
  start: string | null;
  end: string | null;
  actualStart: string | null;
  today: string;
}): Activity['status_cache'] {
  const { progress, start, end, actualStart, today } = input;
  if (progress >= 100) return 'done';
  if (end && end < today && progress < 100) return 'delayed';
  const withinWindow = start && end && today >= start && today <= end;
  if (withinWindow || (actualStart && progress < 100)) return 'active';
  return 'planned';
}

// ---------------------------------------------------------------------------
// Derivation (C2) — idempotent, unit-testable
// ---------------------------------------------------------------------------
export interface SyncInput {
  dsrData: DsrRecord[];
  boqData: any[];
  milestones?: any[];
  today?: string; // injectable for tests
}

function qtyEntriesFor(dsrData: DsrRecord[], code: string): DsrRecord[] {
  // One line per reported item, whatever shape the report has (legacy flat
  // record or multi-item document). Sorted oldest-first: the crossing date and
  // the early-work alert both depend on chronological order.
  return dsrLines(dsrData as any[])
    .filter((l) => sameCode(l.boqCode, code) && l.quantity > 0)
    .map((l) => ({ id: l.reportId, date: l.date, boqCode: l.boqCode, workQuantity: l.quantity }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/** Date on which a regular activity's cumulative qty first reached 100% (or null). */
function crossingDate(entries: DsrRecord[], boqQty: number): string | null {
  if (!(boqQty > 0)) return null;
  let cum = 0;
  for (const e of entries) {
    cum += Number(e.workQuantity);
    if (cum >= boqQty) return String(e.date).slice(0, 10);
  }
  return null;
}

/**
 * Recompute all derived columns for every activity and persist them (C4).
 * Idempotent: same inputs → same derived outputs (synced_at is metadata).
 * NEVER touches start/end/baseline_start/baseline_end (C6).
 */
export function syncFromDSR(input: SyncInput): { activities: Activity[]; alerts: SyncAlert[] } {
  const today = input.today || todayISO();
  const { activities, dependencies } = ensureStore({ boqData: input.boqData, milestones: input.milestones || [] });
  const boqQty = new Map<string, number>();
  for (const s of input.boqData || []) {
    for (const it of s.children || []) boqQty.set(it.itemCode, Number(it.estimatedQuantity) || 0);
  }

  const syncedAt = new Date().toISOString();
  const firstPass = new Map<string, Activity>();

  for (const act of activities) {
    if (act.is_milestone) continue; // handled below (needs predecessors' results)
    const entries = qtyEntriesFor(input.dsrData, act.code);
    const qty = boqQty.get(act.code) ?? 0;
    const cumulative = cumulativeDone(input.dsrData, act.code);
    const progress = progressOf(cumulative, qty);
    const workedDays = new Set(entries.map((e) => String(e.date).slice(0, 10))).size;
    const avgDailyOut = workedDays > 0 ? Math.round((cumulative / workedDays) * 100) / 100 : 0;
    const remaining = Math.max(0, qty - cumulative);
    let forecast: string | null = null;
    if (entries.length > 0) {
      forecast = avgDailyOut > 0 && progress < 100 ? addDaysISO(today, Math.ceil(remaining / avgDailyOut)) : (progress >= 100 ? String(entries[entries.length - 1].date).slice(0, 10) : null);
    }
    const actualStart = entries.length ? String(entries[0].date).slice(0, 10) : null;
    const done = progress >= 100;
    const actualFinish = done && entries.length ? String(entries[entries.length - 1].date).slice(0, 10) : null;
    const next: Activity = {
      ...act,
      progress,
      actual_start: actualStart,
      actual_finish: actualFinish,
      forecast_finish: forecast,
      status_cache: statusFor({ progress, start: act.start, end: act.end, actualStart, today }),
      synced_at: syncedAt,
    };
    firstPass.set(act.id, next);
  }

  // Milestones: progress = min over predecessors (C2); auto-flip to done when
  // all predecessors reach 100 — the ONLY auto-write, to Gantt's own table (C5).
  const predsOf = new Map<string, Dependency[]>();
  for (const d of dependencies) {
    const list = predsOf.get(d.to_id) || [];
    list.push(d);
    predsOf.set(d.to_id, list);
  }
  for (const act of activities) {
    if (!act.is_milestone) continue;
    const preds = (predsOf.get(act.id) || [])
      .map((d) => firstPass.get(d.from_id) || activities.find((a) => a.id === d.from_id))
      .filter(Boolean) as Activity[];
    let progress: number;
    let actualFinish: string | null = null;
    if (preds.length > 0) {
      progress = Math.min(...preds.map((p) => p.progress));
      const crossings = preds
        .map((p) => p.actual_finish)
        .filter(Boolean)
        .sort() as string[];
      actualFinish = preds.every((p) => p.progress >= 100) && crossings.length ? crossings[crossings.length - 1] : null;
    } else {
      // no predecessors → fall back to its own BOQ progress
      progress = progressOf(cumulativeDone(input.dsrData, act.code), boqQty.get(act.code) ?? 0);
      actualFinish = progress >= 100 ? today : null;
    }
    firstPass.set(act.id, {
      ...act,
      progress: Math.round(progress * 100) / 100,
      actual_start: null, // instantaneous — only the actual date matters
      actual_finish: actualFinish,
      forecast_finish: null,
      status_cache: statusFor({
        progress,
        start: act.start,
        end: act.end,
        actualStart: null,
        today,
      }),
      synced_at: syncedAt,
    });
  }

  const derived = activities.map((a) => firstPass.get(a.id) || a);
  saveActivities(derived);
  const alerts = computeAlerts(derived, input.dsrData, dependencies, today);
  emitChange();
  return { activities: derived, alerts };
}

// ---------------------------------------------------------------------------
// Sync alerts (C5)
// ---------------------------------------------------------------------------
export function computeAlerts(
  activities: Activity[],
  dsrData: DsrRecord[],
  dependencies: Dependency[],
  today: string
): SyncAlert[] {
  void dependencies;
  const alerts: SyncAlert[] = [];
  for (const act of activities) {
    if (act.is_milestone) continue;

    // (a) work reported before planned start
    if (act.start) {
      const early = qtyEntriesFor(dsrData, act.code).filter((e) => String(e.date).slice(0, 10) < act.start!);
      if (early.length) {
        alerts.push({
          id: `early:${act.id}`,
          kind: 'early-dsr',
          severity: 'amber',
          activityId: act.id,
          message: `Work reported on “${act.name}” before its planned start (${early[0].date} < ${act.start})`,
        });
      }
    }

    // (b) active activity with no DSR entry for > 3 consecutive working days
    if (act.status_cache === 'active') {
      const entries = qtyEntriesFor(dsrData, act.code);
      const anchor = entries.length
        ? String(entries[entries.length - 1].date).slice(0, 10)
        : act.actual_start || act.start;
      if (anchor) {
        const idleWorkingDays = workingDaysBetween(anchor, today);
        if (idleWorkingDays > 3) {
          alerts.push({
            id: `stale:${act.id}`,
            kind: 'stale-active',
            severity: 'amber',
            activityId: act.id,
            message: `“${act.name}” is active with no DSR entry for ${idleWorkingDays} working days`,
          });
        }
      }
    }

    // (c) forecast finish later than planned end → forecast slip +Nd (red).
    // Forecasts only apply to OPEN work — a finished activity's late actual is
    // already visible via actual_finish + the slip chip, not a "forecast".
    if (act.progress < 100 && act.forecast_finish && act.end && act.forecast_finish > act.end) {
      const slip = daysBetween(act.end, act.forecast_finish);
      alerts.push({
        id: `slip:${act.id}`,
        kind: 'forecast-slip',
        severity: 'red',
        activityId: act.id,
        message: `Forecast slip +${slip}d on “${act.name}” — consider a baseline review (no dates changed)`,
      });
    }
  }
  return alerts;
}

// ---------------------------------------------------------------------------
// Plain-language dependency labels (B5 — never render raw codes)
// ---------------------------------------------------------------------------
export const DEP_PHRASE: Record<DepType, (pred: string) => string> = {
  FS: (p) => `after: ${p}`,
  SS: (p) => `starts together with: ${p}`,
  FF: (p) => `finishes together with: ${p}`,
  SF: (p) => `finishes after the start of: ${p}`,
};

export function depPhrase(dep: Dependency, activities: Activity[]): string {
  const pred = activities.find((a) => a.id === dep.from_id);
  const base = DEP_PHRASE[dep.type](pred ? pred.name : 'unknown');
  return dep.lag_days > 0 ? `${base} + ${dep.lag_days}d` : base;
}

// ---------------------------------------------------------------------------
// List-view CSV (F9: includes bs_date, ad_date, progress, slip)
// ---------------------------------------------------------------------------
export function slipDays(act: Activity): number | null {
  if (!act.baseline_end || !act.end) return null;
  return daysBetween(act.baseline_end, act.end);
}

export function ganttListCsv(activities: Activity[]): string {
  const header = ['code', 'name', 'sector', 'status', 'progress', 'ad_start', 'ad_end', 'bs_date', 'ad_date', 'slip_days', 'actual_start', 'actual_finish', 'forecast_finish'];
  const rows = activities.map((a) => {
    const endAd = a.end || '';
    // A date outside the calendar table leaves the B.S. column blank; it must
    // never abort the whole CSV export.
    const bs = endAd ? tryAdToBS(new Date(Date.UTC(Number(endAd.slice(0, 4)), Number(endAd.slice(5, 7)) - 1, Number(endAd.slice(8, 10)), 12))) : null;
    const bsDate = bs ? `${bs.year}-${String(bs.month).padStart(2, '0')}-${String(bs.day).padStart(2, '0')}` : '';
    const slip = slipDays(a);
    return [
      a.code,
      a.name,
      a.sector,
      a.status_cache,
      String(a.progress),
      a.start || '',
      endAd,
      bsDate, // bs_date
      endAd, // ad_date
      slip === null ? '' : String(slip), // slip
      a.actual_start || '',
      a.actual_finish || '',
      a.forecast_finish || '',
    ];
  });
  return [header, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
}

export { formatBS };
