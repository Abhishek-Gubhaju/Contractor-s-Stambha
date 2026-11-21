// ============================================================================
// dsrService — the Daily Site Report as contractors actually keep it.
//
// A report is a DOCUMENT, numbered in one series per job and fiscal year. Most
// jobs keep one per working day, but a job that records separate fronts, shifts
// or clients may hold several reports for the same date — each is a separate
// document and all of them count towards progress. A report has sections:
//
//   work       BOQ item, quantity done today, unit, location, remark
//   labour     trade, headcount, hours, overtime
//   plant      equipment/machinery, hours worked, idle hours, breakdown note
//   materials  received at site, used today, supplier, challan no.
//   tests      quality tests (cube, slump, compaction, sieve) with result
//   delays     interruption and hours lost (rain, strike, breakdown, no drawings)
//   safety     toolbox talk, PPE, incident record
//
// The ledger, Gantt, Work Progress, Job Costing and the Dashboard all read the
// same quantities through ONE rule — `dsrLines()` — so a multi-item report is
// counted exactly like the single-line reports it replaces. Legacy single-item
// records are migrated on read, never rewritten in place.
//
// Status is a small, explicit workflow: draft → submitted → approved. An
// approved report is LOCKED: it can only be reopened with a reason, and every
// transition is written into the report's own history.
// ============================================================================
import { adToBS } from '../utils/nepaliDate';
import { fiscalYearOf } from './periods';

const DSR_SEQ_PREFIX = 'DSR';

/** Two-decimal rounding for every quantity the module exposes. */
export const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type DsrStatus = 'draft' | 'submitted' | 'approved';

export type DsrWeather = 'clear' | 'cloudy' | 'overcast' | 'light-rain' | 'heavy-rain' | 'fog';

export const WEATHER_LABEL: Record<DsrWeather, string> = {
  clear: 'Clear',
  cloudy: 'Cloudy',
  overcast: 'Overcast',
  'light-rain': 'Light rain',
  'heavy-rain': 'Heavy rain',
  fog: 'Fog',
};

export type DsrShift = 'day' | 'night' | 'both';

export const SHIFT_LABEL: Record<DsrShift, string> = {
  day: 'Day',
  night: 'Night',
  both: 'Day + night',
};

export interface DsrWorkItem {
  id: string;
  boqCode: string;
  description: string;
  unit: string;
  quantity: number;
  /** Chainage / pier / span / floor / block — where the work happened. */
  location: string;
  remark: string;
}

export interface DsrLabourRow {
  id: string;
  trade: string;
  count: number;
  hours: number;
  overtimeHours: number;
}

export interface DsrPlantRow {
  id: string;
  name: string;
  hours: number;
  idleHours: number;
  note: string;
}

export interface DsrMaterialRow {
  id: string;
  name: string;
  unit: string;
  received: number;
  used: number;
  supplier: string;
  challan: string;
}

export interface DsrTestRow {
  id: string;
  kind: string;
  location: string;
  result: string;
  passed: boolean;
}

export interface DsrDelayRow {
  id: string;
  reason: string;
  hours: number;
}

export interface DsrSafety {
  toolbox: boolean;
  ppe: boolean;
  incident: string;
  notes: string;
}

/**
 * One file the report links to. The bytes and the folder live in the File
 * Vault; this is only the reference the DSR keeps, denormalised just enough
 * that a missing vault row still prints an honest name and size.
 */
export interface DsrAttachment {
  /** The vault document id — the only link to the bytes. */
  id: string;
  name: string;
  ext: string;
  sizeBytes: number;
  addedAt: string;
}

/** Files one report may link. Enforced at attach time and validated on save. */
export const MAX_DSR_ATTACHMENTS = 50;

export interface DsrHistoryEntry {
  at: string;
  action: 'create' | 'edit' | 'submit' | 'approve' | 'reopen' | 'delete';
  reason: string;
  status: DsrStatus;
}

export interface DsrReport {
  id: string;
  reportNo: string;
  date: string; // canonical A.D. "YYYY-MM-DD"
  bs_y: number;
  bs_m: number;
  bs_d: number;
  project_id: string;
  weather: DsrWeather;
  shift: DsrShift;
  items: DsrWorkItem[];
  labour: DsrLabourRow[];
  plant: DsrPlantRow[];
  materials: DsrMaterialRow[];
  tests: DsrTestRow[];
  delays: DsrDelayRow[];
  safety: DsrSafety;
  /** Files filed in the File Vault for this report (metadata only). */
  attachments: DsrAttachment[];
  instructions: string;
  visitors: string;
  note: string;
  preparedBy: string;
  checkedBy: string;
  status: DsrStatus;
  submittedAt: string;
  approvedAt: string;
  created_at: string;
  updated_at: string;
  history: DsrHistoryEntry[];
  /**
   * Compatibility mirrors of the first work item. Every consumer that still
   * reads `boqCode`/`workQuantity` keeps working; new code uses dsrLines().
   */
  boqCode: string;
  boqDescription: string;
  workSummary: string;
  workQuantity: number;
  unit: string;
  laborHeadcount: number;
  isSubmitted: boolean;
}

// ---------------------------------------------------------------------------
// Date helpers (B.S. integers are stored once, at write)
// ---------------------------------------------------------------------------
export function safeBs(adDate: string): { year: number; month: number; day: number } {
  const d = String(adDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { year: 0, month: 0, day: 0 };
  try {
    return adToBS(new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)), 12)));
  } catch {
    return { year: 0, month: 0, day: 0 };
  }
}

export function todayAD(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kathmandu',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

// ---------------------------------------------------------------------------
// Item/row factories (the editor's "+ add" rows)
// ---------------------------------------------------------------------------
let seq = 0;
function uid(prefix: string): string {
  seq = (seq + 1) % 100000;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}`;
}

export function blankWorkItem(): DsrWorkItem {
  return { id: uid('wi'), boqCode: '', description: '', unit: '', quantity: 0, location: '', remark: '' };
}
export function blankLabourRow(): DsrLabourRow {
  return { id: uid('lb'), trade: '', count: 0, hours: 8, overtimeHours: 0 };
}
export function blankPlantRow(): DsrPlantRow {
  return { id: uid('pl'), name: '', hours: 0, idleHours: 0, note: '' };
}
export function blankMaterialRow(): DsrMaterialRow {
  return { id: uid('mt'), name: '', unit: '', received: 0, used: 0, supplier: '', challan: '' };
}
export function blankTestRow(): DsrTestRow {
  return { id: uid('ts'), kind: '', location: '', result: '', passed: true };
}
export function blankDelayRow(): DsrDelayRow {
  return { id: uid('dl'), reason: '', hours: 0 };
}

export function blankReport(projectId: string, date = todayAD()): DsrReport {
  const bs = safeBs(date);
  return {
    id: uid('dsr'),
    reportNo: '',
    date,
    bs_y: bs.year,
    bs_m: bs.month,
    bs_d: bs.day,
    project_id: projectId,
    weather: 'clear',
    shift: 'day',
    items: [blankWorkItem()],
    labour: [],
    plant: [],
    materials: [],
    tests: [],
    delays: [],
    safety: { toolbox: false, ppe: false, incident: '', notes: '' },
    attachments: [],
    instructions: '',
    visitors: '',
    note: '',
    preparedBy: '',
    checkedBy: '',
    status: 'draft',
    submittedAt: '',
    approvedAt: '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    history: [],
    boqCode: '',
    boqDescription: '',
    workSummary: '',
    workQuantity: 0,
    unit: '',
    laborHeadcount: 0,
    isSubmitted: false,
  };
}

// ---------------------------------------------------------------------------
// Migration (legacy single-line record → document)
// ---------------------------------------------------------------------------
function isLegacyReport(raw: any): boolean {
  return Boolean(raw) && !Array.isArray(raw.items) && typeof raw.boqCode !== 'undefined';
}

export function migrateReport(raw: any, projectId: string): DsrReport {
  if (!isLegacyReport(raw)) {
    const report = raw as DsrReport;
    return {
      ...blankReport(report.project_id || projectId, report.date),
      ...report,
      items: normalizeItems(report.items || []),
      labour: normalizeRows(report.labour || []),
      plant: normalizeRows(report.plant || []),
      materials: normalizeRows(report.materials || []),
      tests: normalizeRows(report.tests || []),
      delays: normalizeRows(report.delays || []),
      // Normalised after the spread, so an older report (no attachments at all)
      // still gets a stable, empty list.
      attachments: normalizeAttachments(report.attachments),
      safety: {
        toolbox: Boolean(report.safety?.toolbox),
        ppe: Boolean(report.safety?.ppe),
        incident: String(report.safety?.incident || ''),
        notes: String(report.safety?.notes || ''),
      },
      history: Array.isArray(report.history) ? report.history : [],
      project_id: report.project_id || projectId,
      status: report.status || 'draft',
      submittedAt: report.submittedAt || '',
      approvedAt: report.approvedAt || '',
    };
  }
  const date = String(raw.date || '').slice(0, 10);
  const bs = safeBs(date);
  const base = blankReport(projectId, date);
  const qty = Number(raw.workQuantity) || 0;
  return {
    ...base,
    id: String(raw.id || base.id),
    reportNo: String(raw.reportNo || ''),
    bs_y: bs.year,
    bs_m: bs.month,
    bs_d: bs.day,
    items: raw.boqCode
      ? [
          {
            id: uid('wi'),
            boqCode: String(raw.boqCode),
            description: String(raw.boqDescription || raw.workSummary || ''),
            unit: String(raw.unit || ''),
            quantity: qty,
            location: '',
            remark: String(raw.workSummary || ''),
          },
        ]
      : [],
    labour: raw.laborHeadcount ? [{ id: uid('lb'), trade: 'Site labour', count: Number(raw.laborHeadcount) || 0, hours: 8, overtimeHours: 0 }] : [],
    status: raw.isSubmitted ? 'submitted' : 'draft',
    submittedAt: raw.isSubmitted ? String(raw.created_at || '') : '',
    created_at: String(raw.created_at || new Date().toISOString()),
    updated_at: String(raw.updated_at || raw.created_at || new Date().toISOString()),
    history: [{ at: String(raw.created_at || new Date().toISOString()), action: 'create', reason: 'Migrated from the single-line DSR', status: raw.isSubmitted ? 'submitted' : 'draft' }],
    boqCode: String(raw.boqCode || ''),
    boqDescription: String(raw.boqDescription || ''),
    workSummary: String(raw.workSummary || ''),
    workQuantity: qty,
    unit: String(raw.unit || ''),
    laborHeadcount: Number(raw.laborHeadcount) || 0,
    isSubmitted: Boolean(raw.isSubmitted),
  };
}

/**
 * Make stored attachment references safe to use: strings trimmed, ids unique,
 * size finite, no row that cannot identify a vault document. The count is NOT
 * silently truncated here — validateReport() refuses an over-limit report so
 * nobody loses a file reference without being told.
 */
export function normalizeAttachments(raw: unknown): DsrAttachment[] {
  const rows = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const out: DsrAttachment[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const value = row as Partial<DsrAttachment>;
    const id = String(value.id ?? '').trim();
    if (!id || seen.has(id)) continue;
    const name = String(value.name ?? '').trim().slice(0, 180);
    if (!name) continue;
    const rawExt = String(value.ext ?? '').trim().toLowerCase().replace(/^\./, '');
    const ext = /^[a-z0-9]{1,16}$/.test(rawExt) ? rawExt : '';
    const size = Number(value.sizeBytes);
    const addedAt = String(value.addedAt ?? '');
    seen.add(id);
    out.push({
      id,
      name,
      ext,
      sizeBytes: Number.isFinite(size) && size > 0 ? size : 0,
      addedAt: /^\d{4}-\d{2}-\d{2}T/.test(addedAt) ? addedAt : '',
    });
    // A pathological list (thousands of rows) is stopped early; validation
    // still reports the over-limit state for anything up to this guard.
    if (out.length >= MAX_DSR_ATTACHMENTS * 10) break;
  }
  return out;
}

function normalizeItems(items: any[]): DsrWorkItem[] {
  return (items || []).filter(Boolean).map((it) => ({
    id: String(it.id || uid('wi')),
    boqCode: String(it.boqCode || ''),
    description: String(it.description || ''),
    unit: String(it.unit || ''),
    quantity: round2(it.quantity),
    location: String(it.location || ''),
    remark: String(it.remark || ''),
  }));
}
function normalizeRows<T extends { id?: string }>(rows: any[]): T[] {
  return (rows || []).filter(Boolean).map((r) => ({ ...r, id: String(r.id || uid('row')) })) as T[];
}

/** Migrate a whole store; idempotent. */
export function migrateReports(raw: any, projectId = ''): DsrReport[] {
  const list = Array.isArray(raw) ? raw : [];
  return list.filter(Boolean).map((r) => migrateReport(r, projectId));
}

// ---------------------------------------------------------------------------
// THE shared aggregation rule (dsrLines)
// ---------------------------------------------------------------------------
interface DsrLine {
  reportId: string;
  date: string;
  boqCode: string;
  description: string;
  quantity: number;
  unit: string;
  location: string;
  status: DsrStatus;
}

/**
 * Flatten any mix of legacy and document reports into work lines. Approved,
 * submitted and draft reports all count as work done — the approval state is
 * a paperwork status, not a different quantity.
 */
export function dsrLines(records: any[]): DsrLine[] {
  const out: DsrLine[] = [];
  for (const raw of records || []) {
    if (!raw) continue;
    const report = Array.isArray(raw.items) ? (raw as DsrReport) : migrateReport(raw, String(raw.project_id || ''));
    const status: DsrStatus = report.status || 'draft';
    for (const it of report.items || []) {
      if (!it) continue;
      out.push({
        reportId: report.id,
        date: String(report.date || '').slice(0, 10),
        boqCode: String(it.boqCode || ''),
        description: String(it.description || ''),
        quantity: Number(it.quantity) || 0,
        unit: String(it.unit || ''),
        location: String(it.location || ''),
        status,
      });
    }
  }
  return out;
}

/** Σ quantity for one BOQ code across every report shape. */
export function cumulativeFor(records: any[], boqCode: string): number {
  const key = String(boqCode || '').trim().toLowerCase();
  if (!key) return 0;
  return round2(
    dsrLines(records)
      .filter((l) => l.boqCode.toLowerCase() === key)
      .reduce((s, l) => s + l.quantity, 0)
  );
}

/** Cumulative for every code at once (one pass — used by list/dashboard views). */
export function cumulativeMap(records: any[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const l of dsrLines(records)) {
    const key = l.boqCode.trim().toLowerCase();
    if (!key) continue;
    map.set(key, round2((map.get(key) || 0) + l.quantity));
  }
  return map;
}

/** Cumulative of a code strictly before `date` — the "previous" figure. */
export function cumulativeBefore(records: any[], boqCode: string, date: string): number {
  const key = String(boqCode || '').trim().toLowerCase();
  return round2(
    dsrLines(records)
      .filter((l) => l.boqCode.toLowerCase() === key && l.date < date)
      .reduce((s, l) => s + l.quantity, 0)
  );
}

// ---------------------------------------------------------------------------
// Derived figures
// ---------------------------------------------------------------------------
export function labourCount(report: DsrReport): number {
  return (report.labour || []).reduce((s, r) => s + (Number(r.count) || 0), 0);
}
export function labourHours(report: DsrReport): number {
  return round2(
    (report.labour || []).reduce((s, r) => s + (Number(r.count) || 0) * (Number(r.hours) || 0) + (Number(r.overtimeHours) || 0), 0)
  );
}
export function delayHours(report: DsrReport): number {
  return round2((report.delays || []).reduce((s, d) => s + (Number(d.hours) || 0), 0));
}
export function plantHours(report: DsrReport): number {
  return round2((report.plant || []).reduce((s, p) => s + (Number(p.hours) || 0), 0));
}
export function plantIdleHours(report: DsrReport): number {
  return round2((report.plant || []).reduce((s, p) => s + (Number(p.idleHours) || 0), 0));
}

/** "CH 0+250" style location is free text; this keeps it trimmed and printable. */
// ---------------------------------------------------------------------------
// Numbering — one series per project per fiscal year: DSR-2083/84-001
// ---------------------------------------------------------------------------
export function reportPrefix(date: string): string {
  const bs = safeBs(date);
  const fy = fiscalYearOf(bs.year, bs.month);
  return `${DSR_SEQ_PREFIX}-${fy.label}-`;
}

export function nextReportNo(date: string, existing: DsrReport[]): string {
  const prefix = reportPrefix(date);
  let max = 0;
  for (const r of existing || []) {
    const no = String(r.reportNo || '');
    if (!no.startsWith(prefix)) continue;
    const n = Number(no.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

// ---------------------------------------------------------------------------
// Validation — hard errors block saving; warnings are advisory
// ---------------------------------------------------------------------------
interface DsrValidation {
  errors: string[];
  warnings: string[];
}

export interface BoqRef {
  itemCode: string;
  description: string;
  unit: string;
  quantity: number;
  rate: number;
}

/**
 * Validate a report before save. `submit` is stricter: a submitted or approved
 * report must name its work, because that is what progress is measured from.
 */
export function validateReport(
  report: DsrReport,
  opts: { existing?: DsrReport[]; boq?: BoqRef[]; submit?: boolean; today?: string; projectId?: string } = {}
): DsrValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const today = opts.today || todayAD();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(report.date)) errors.push('A valid date is required.');
  else if (report.date > today) errors.push('A daily report cannot be dated in the future.');
  if (opts.projectId && report.project_id && report.project_id !== opts.projectId) {
    errors.push('The report belongs to a different job.');
  }

  // Several reports may share a date (a second work front or shift). Say so, so
  // an accidental duplicate is noticed, but never block the second entry — the
  // register is a numbered document log, not one slot per day.
  const sameDate = (opts.existing || []).filter((r) => r.date === report.date && r.id !== report.id);
  if (sameDate.length > 0) {
    const numbers = sameDate.map((r) => r.reportNo || r.id).join(', ');
    warnings.push(`Another report already exists for ${report.date} (${numbers}) — this one is additional and both count towards progress.`);
  }

  const items = (report.items || []).filter((i) => i.boqCode || i.quantity || i.description);
  if (items.length === 0) {
    if (opts.submit) errors.push('A report needs at least one work item before it is submitted.');
    else warnings.push('No work item yet — the report can still be saved as a draft.');
  }

  const seen = new Set<string>();
  const boqByCode = new Map((opts.boq || []).map((b) => [b.itemCode.trim().toLowerCase(), b]));
  for (const [i, it] of items.entries()) {
    const label = `Item ${i + 1}`;
    if (!String(it.boqCode || '').trim()) {
      if (opts.submit) errors.push(`${label}: a BOQ item code is required.`);
      else warnings.push(`${label}: no BOQ code — it will not count towards progress.`);
    } else {
      const key = it.boqCode.trim().toLowerCase();
      if (seen.has(key)) errors.push(`${label}: ${it.boqCode} is already on this report — merge the two lines.`);
      seen.add(key);
      if (opts.boq && opts.boq.length > 0 && !boqByCode.has(key)) {
        warnings.push(`${label}: ${it.boqCode} is not in this job's BOQ.`);
      }
    }
    if (!(Number(it.quantity) >= 0)) errors.push(`${label}: quantity cannot be negative.`);
    if (!String(it.unit || '').trim()) warnings.push(`${label}: no unit — the print will leave it blank.`);
    if (Number(it.quantity) === 0 && opts.submit) warnings.push(`${label}: zero quantity.`);

    const boq = boqByCode.get(it.boqCode.trim().toLowerCase());
    if (boq && boq.quantity > 0) {
      const before = cumulativeBefore(opts.existing || [], it.boqCode, report.date);
      const overlap = (opts.existing || [])
        .filter((r) => r.id !== report.id && r.date === report.date)
        .reduce((s, r) => s + (r.items || []).filter((x) => x.boqCode.trim().toLowerCase() === boq.itemCode.trim().toLowerCase()).reduce((t, x) => t + (Number(x.quantity) || 0), 0), 0);
      const after = round2(before + overlap + Number(it.quantity));
      if (after > boq.quantity + 0.005) {
        warnings.push(`${it.boqCode}: this entry takes the total to ${after} ${it.unit || boq.unit}, over the BOQ quantity ${boq.quantity}.`);
      }
    }
  }

  for (const [i, row] of (report.labour || []).entries()) {
    if (!String(row.trade || '').trim()) warnings.push(`Labour row ${i + 1}: no trade.`);
    if (Number(row.count) < 0) errors.push(`Labour row ${i + 1}: headcount cannot be negative.`);
    if (Number(row.hours) < 0 || Number(row.hours) > 24) errors.push(`Labour row ${i + 1}: hours must be between 0 and 24.`);
    if (Number(row.overtimeHours) < 0 || Number(row.overtimeHours) > 24) errors.push(`Labour row ${i + 1}: overtime must be between 0 and 24.`);
  }

  for (const [i, row] of (report.plant || []).entries()) {
    if (!String(row.name || '').trim() && (row.hours || row.idleHours)) errors.push(`Plant row ${i + 1}: an equipment name is required.`);
    if (Number(row.hours) < 0 || Number(row.hours) > 24) errors.push(`Plant row ${i + 1}: hours must be between 0 and 24.`);
    if (Number(row.idleHours) < 0) errors.push(`Plant row ${i + 1}: idle hours cannot be negative.`);
  }

  for (const [i, row] of (report.materials || []).entries()) {
    if (!String(row.name || '').trim() && (row.received || row.used)) errors.push(`Material row ${i + 1}: a material name is required.`);
    if (Number(row.received) < 0 || Number(row.used) < 0) errors.push(`Material row ${i + 1}: quantities cannot be negative.`);
    if (Number(row.used) > Number(row.received) + 0.005 && Number(row.received) > 0) {
      warnings.push(`Material row ${i + 1}: used more than received today — check the opening stock at site.`);
    }
  }

  for (const [i, row] of (report.tests || []).entries()) {
    if (String(row.kind || '').trim() && !String(row.result || '').trim()) {
      warnings.push(`Test row ${i + 1}: no result recorded.`);
    }
  }

  const delays = delayHours(report);
  if (delays > 24) errors.push('Lost time cannot exceed 24 hours in one day.');
  if (delays > 0 && !(report.delays || []).some((d) => String(d.reason || '').trim())) {
    errors.push('A delay needs a reason.');
  }

  const attachments = report.attachments || [];
  if (attachments.length > MAX_DSR_ATTACHMENTS) {
    errors.push(
      `A report can link ${MAX_DSR_ATTACHMENTS} files — this one links ${attachments.length}. Remove the extras before saving.`
    );
  }
  const attachmentIds = new Set<string>();
  for (const row of attachments) {
    const id = String(row?.id || '').trim();
    if (!id) {
      errors.push('One attachment has no vault id — remove it and add the file again.');
      continue;
    }
    if (attachmentIds.has(id)) {
      errors.push(`${row.name || id}: the same file is linked twice — remove one copy.`);
    }
    attachmentIds.add(id);
  }

  // Status is not a validation problem: the editor is read-only for an approved
  // report and reopening is a separate, reasoned action.
  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Status workflow
// ---------------------------------------------------------------------------
export function canEdit(report: DsrReport): boolean {
  return report.status !== 'approved';
}

function withHistory(report: DsrReport, action: DsrHistoryEntry['action'], reason: string, status: DsrStatus): DsrReport {
  return {
    ...report,
    status,
    updated_at: new Date().toISOString(),
    isSubmitted: status !== 'draft',
    submittedAt: status === 'submitted' ? report.submittedAt || new Date().toISOString() : report.submittedAt,
    approvedAt: status === 'approved' ? report.approvedAt || new Date().toISOString() : report.approvedAt,
    history: [...(report.history || []), { at: new Date().toISOString(), action, reason: String(reason || '').trim(), status }],
  };
}

export function submitReport(report: DsrReport, reason = ''): DsrReport {
  if (report.status !== 'draft') throw new Error(`${report.reportNo || report.id} is already ${report.status}.`);
  return withHistory(report, 'submit', reason || 'Submitted to the engineer', 'submitted');
}

export function approveReport(report: DsrReport, reason = ''): DsrReport {
  if (report.status !== 'submitted') throw new Error('Only a submitted report can be approved.');
  return withHistory(report, 'approve', reason || 'Checked and approved', 'approved');
}

export function reopenReport(report: DsrReport, reason: string): DsrReport {
  if (!String(reason || '').trim()) throw new Error('A reason is required to reopen an approved report.');
  if (report.status !== 'approved') throw new Error('Only an approved report needs reopening.');
  return withHistory(report, 'reopen', reason.trim(), 'draft');
}

/** Keep the compatibility mirrors in step after any edit. */
export function withMirrors(report: DsrReport): DsrReport {
  const first = (report.items || [])[0];
  const bs = safeBs(report.date);
  const status: DsrStatus = report.status || 'draft';
  return {
    ...report,
    bs_y: bs.year,
    bs_m: bs.month,
    bs_d: bs.day,
    status,
    boqCode: first?.boqCode || '',
    boqDescription: first?.description || '',
    workSummary:
      (report.items || [])
        .map((i) => i.description || i.boqCode)
        .filter(Boolean)
        .slice(0, 3)
        .join('; ') || '',
    workQuantity: round2((report.items || []).reduce((s, i) => s + (Number(i.quantity) || 0), 0)),
    unit: first?.unit || '',
    laborHeadcount: labourCount(report),
    isSubmitted: status !== 'draft',
    updated_at: new Date().toISOString(),
  };
}

/** Sort newest first, then by report number (stable inside one day). */
export function sortReports(reports: DsrReport[]): DsrReport[] {
  return [...reports].sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.reportNo).localeCompare(String(a.reportNo)));
}

