// ============================================================================
// labourService — Labour Ledger backend (Section C) + integration contract
// (Section D).
//
// • Worker master merges Staff Info (C2) with site labourers (so every
//   attendance worker_id resolves), plus per-worker rate configuration.
// • Earnings are computed from Attendance ONLY (C3) — never re-entered.
// • Advances and payroll post through booksService.saveEntry() — the ONE
//   double-entry posting path (S2.3). Payroll approve → payroll-accrual
//   auto-entry; payroll pay → payroll-payment auto-entry (S5.1). The old
//   legacy-ledger writes are deleted (S0.2).
// • All dated records store canonical A.D. + bs_year/bs_month/bs_day (A3).
// ============================================================================
import { adToBS } from '../utils/nepaliDate';
import { LedgerMethod } from './ledgerService';
import {
  saveEntry,
  computeReconciliation,
  entriesForRef,
  payrollAccrualEntry,
  payrollPaymentEntry,
  type Reconciliation,
  type Entry as BooksEntry,
} from './booksService';
import { BSPeriod, periodAdRange, periodKey, fiscalYearOf } from './periods';

import { readScoped, writeScoped } from './projectScope';

export const STAFF_KEY = 'contractoros_staff';
export const LABOR_KEY = 'contractoros_labor';
export const WORKER_RATES_KEY = 'contractoros_worker_rates';
export const ATTENDANCE_KEY = 'contractoros_attendance';
export const TX_KEY = 'contractoros_labour_tx';
export const RUNS_KEY = 'contractoros_payroll_runs';
export const SETTINGS_KEY = 'contractoros_settings';

export type RateType = 'daily' | 'monthly' | 'piece';
export type LabourTxType = 'earning' | 'advance' | 'payment' | 'deduction' | 'bonus';
export type RunStatus = 'draft' | 'approved' | 'paid' | 'locked';

/** workers(...) schema (Section E) + payment method for payroll vouchers. */
export interface Worker {
  id: string;
  name: string;
  trade: string;
  rate_type: RateType;
  rate: number;
  ot_multiplier: number;
  status: string;
  payment_method: Extract<LedgerMethod, 'cash' | 'bank'>;
  origin: 'staff' | 'labour';
  /** Staff/worker number, shown only to tell two people with one name apart. */
  code?: string;
}

/** attendance(...) schema (Section E). */
export interface AttendanceRow {
  id: string;
  worker_id: string;
  date: string;
  project_id: string;
  cost_code: string;
  status: string;
  ot_hours: number;
  piece_qty: number;
}

/** labour_tx(...) schema (Section E). */
export interface LabourTx {
  id: string;
  worker_id: string;
  date: string;
  bs_year: number;
  bs_month: number;
  bs_day: number;
  type: LabourTxType;
  amount: number;
  project_id: string;
  ref: string;
  main_voucher_id: string;
  note: string;
}

export interface WorkerNet {
  worker_id: string;
  earned: number;
  advances: number;
  deductions: number;
  bonuses: number;
  net: number;
  payable: number;
  carry: number; // negative net carried forward (over-advanced)
  byProject: Record<string, number>;
}

export interface RunTotals {
  earned: number;
  advances: number;
  deductions: number;
  bonuses: number;
  net: number;
  payable: number;
  byMethod: Record<string, number>;
  perWorker: WorkerNet[];
  projectSplits: Record<string, number>;
}

/** payroll_runs(...) schema (Section E). */
export interface PayrollRun {
  id: string;
  bs_year: number;
  bs_month: number;
  status: RunStatus;
  totals_json: RunTotals;
  posted_vouchers: string[];
  paid_at: string | null;
  created_at: string;
  approved_at: string | null;
  locked_at: string | null;
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

function readJSON<T>(key: string, fallback: T): T {
  // People, attendance, payroll AND the payroll/fiscal settings behind them
  // belong to the active job.
  return readScoped<T>(key, fallback);
}

function writeJSON(key: string, value: unknown) {
  writeScoped(key, value);
}

function emitChange() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('contractoros:ledger-changed'));
    window.dispatchEvent(new CustomEvent('contractoros:labour-changed'));
  }
}

function bsFromAD(adDate: string) {
  const d = String(adDate).slice(0, 10);
  // Noon UTC = same calendar day in Kathmandu (17:45 local), regardless of
  // the machine timezone — calendar-date → B.S. without fixed offsets (F1).
  return adToBS(new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)), 12)));
}

function kathmanduToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kathmandu',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

// ---------------------------------------------------------------------------
// Worker master (C2)
// ---------------------------------------------------------------------------
export interface WorkerRateOverride {
  rate_type?: RateType;
  rate?: number;
  ot_multiplier?: number;
  payment_method?: 'cash' | 'bank';
}

/**
 * The name of a staff record. Staff entered on the Staff Info page keep
 * firstName / middleName / lastName plus a code; imported or older records may
 * only have fullName. A record with neither still reads as a person — a raw id
 * is never shown where a name belongs.
 */
export function staffWorkerName(staff: any): string {
  const parts = [staff?.firstName, staff?.middleName, staff?.lastName]
    .map((v) => String(v ?? '').trim())
    .filter(Boolean);
  if (parts.length > 0) return parts.join(' ');
  const legacy = String(staff?.fullName ?? staff?.name ?? '').trim();
  if (legacy) return legacy;
  const code = String(staff?.code ?? '').trim();
  return code ? `Staff ${code}` : 'Unnamed staff';
}

/**
 * Display text for a worker picker: the name, plus the staff number only when
 * that name is on file more than once. A unique name stays uncluttered; two
 * people called the same thing never become one indistinguishable row.
 */
export function workerLabel(worker: Worker, all: Worker[] = []): string {
  const name = String(worker?.name || '').trim();
  if (!name) return String(worker?.code || worker?.id || '');
  // Case- and spacing-insensitive: "Alex  Morgan" is the same person's name.
  const key = name.toLowerCase().replace(/\s+/g, ' ');
  const sameName = (all || []).filter((w) => String(w?.name || '').trim().toLowerCase().replace(/\s+/g, ' ') === key);
  if (sameName.length < 2) return name;
  const code = String(worker.code || '').trim();
  return `${name} (${code || worker.id})`;
}

export function loadWorkers(): Worker[] {
  const staff = readJSON<any[]>(STAFF_KEY, []);
  const labour = readJSON<any[]>(LABOR_KEY, []);
  const overrides = readJSON<Record<string, WorkerRateOverride>>(WORKER_RATES_KEY, {});

  const workers: Worker[] = [];
  const seen = new Set<string>();

  for (const s of staff) {
    if (!s || s.id === undefined) continue;
    const id = `staff:${s.id}`; // namespace — never collides with attendance ids
    const bank = String(s.bankAccountNumber || '').trim();
    const base: Worker = {
      id,
      name: staffWorkerName(s),
      code: String(s.code || ''),
      trade: String(s.trade || ''),
      rate_type: 'monthly',
      rate: Number(s.monthlySalary) || 0,
      ot_multiplier: 1.5,
      status: s.status === 'Inactive' ? 'inactive' : s.status === 'On Leave' ? 'on-leave' : 'active',
      payment_method: bank ? 'bank' : 'cash',
      origin: 'staff',
    };
    workers.push({ ...base, ...(overrides[id] || {}) });
    seen.add(id);
  }
  for (const l of labour) {
    if (!l || l.id === undefined) continue;
    const id = String(l.id);
    if (seen.has(id)) continue;
    const base: Worker = {
      id,
      name: String(l.name || id),
      code: String(l.code || ''),
      trade: String(l.trade || ''),
      rate_type: 'daily',
      rate: Number(l.dailyWage) || 0,
      ot_multiplier: 1.5,
      status: l.removedDate ? 'inactive' : 'active',
      payment_method: 'cash',
      origin: 'labour',
    };
    workers.push({ ...base, ...(overrides[id] || {}) });
    seen.add(id);
  }
  return workers;
}

export function getWorker(id: string): Worker | null {
  return loadWorkers().find((w) => w.id === id) ?? null;
}

export function saveWorkerRate(id: string, patch: WorkerRateOverride) {
  const overrides = readJSON<Record<string, WorkerRateOverride>>(WORKER_RATES_KEY, {});
  overrides[id] = { ...(overrides[id] || {}), ...patch };
  writeJSON(WORKER_RATES_KEY, overrides);
  emitChange();
}

// ---------------------------------------------------------------------------
// Attendance (read-only here — C3: days are never re-entered on this page)
// ---------------------------------------------------------------------------
export function loadAttendance(): AttendanceRow[] {
  const store = readJSON<Record<string, any>>(ATTENDANCE_KEY, {});
  const rows: AttendanceRow[] = [];
  for (const [date, value] of Object.entries(store)) {
    const projectId = value && !Array.isArray(value) ? String(value.project_id || '') : '';
    const list = Array.isArray(value) ? value : value && Array.isArray(value.rows) ? value.rows : [];
    for (const r of list) {
      if (!r) continue;
      const workerId = String(r.worker_id ?? r.workerId ?? '');
      if (!workerId) continue;
      rows.push({
        id: `${date}:${workerId}`,
        worker_id: workerId,
        date,
        project_id: String(r.project_id || projectId || ''),
        cost_code: String(r.cost_code || ''),
        status: String(r.status || 'present'),
        ot_hours: Number(r.ot_hours ?? r.overtimeHours ?? 0) || 0,
        piece_qty: Number(r.piece_qty ?? r.pieceQty ?? 0) || 0,
      });
    }
  }
  return rows.sort((a, b) => (a.date < b.date ? -1 : 1));
}

function inPeriod(dateISO: string, p: BSPeriod): boolean {
  const { from, to } = periodAdRange(p);
  const d = String(dateISO).slice(0, 10);
  return d >= from && d <= to;
}

export interface EarningsBreakdown {
  days: number;
  ot_hours: number;
  piece_qty: number;
  day_amount: number;
  ot_amount: number;
  piece_amount: number;
  total: number;
  byProject: Record<string, number>;
  missing_rate: boolean;
}

/**
 * C3: earnings from Attendance ONLY.
 *  daily  → days × rate
 *  monthly→ flat monthly rate, prorated by present days over 30
 *  piece  → piece_qty × rate (piece qty sourced from attendance/Work Progress)
 *  OT     → ot_hours × (dailyEquivalent / 8) × ot_multiplier
 * Project split comes from the attendance day tag (C6/C7).
 */
export function computeEarnings(worker: Worker, rows: AttendanceRow[]): EarningsBreakdown {
  const byProject: Record<string, number> = {};
  let days = 0;
  let ot_hours = 0;
  let piece_qty = 0;
  let day_amount = 0;
  let ot_amount = 0;
  let piece_amount = 0;
  const missing_rate = !worker || !(worker.rate > 0);

  const dayEquivalent =
    worker.rate_type === 'monthly' ? (worker.rate || 0) / 30 : worker.rate_type === 'piece' ? 0 : worker.rate;

  for (const r of rows) {
    if (r.status !== 'present') continue;
    const project = r.project_id || 'general';
    let rowAmount = 0;
    if (worker.rate_type === 'daily') {
      days += 1;
      day_amount += worker.rate;
      rowAmount += worker.rate;
      const ot = r.ot_hours * (dayEquivalent / 8) * worker.ot_multiplier;
      ot_amount += ot;
      rowAmount += ot;
      ot_hours += r.ot_hours;
    } else if (worker.rate_type === 'monthly') {
      days += 1;
      const share = (worker.rate || 0) / 30;
      day_amount += share;
      rowAmount += share;
      const ot = r.ot_hours * ((worker.rate || 0) / 30 / 8) * worker.ot_multiplier;
      ot_amount += ot;
      rowAmount += ot;
      ot_hours += r.ot_hours;
    } else {
      if (r.piece_qty > 0) {
        piece_qty += r.piece_qty;
        const amount = r.piece_qty * worker.rate;
        piece_amount += amount;
        rowAmount += amount;
      }
    }
    byProject[project] = round2((byProject[project] || 0) + rowAmount);
  }
  return {
    days,
    ot_hours,
    piece_qty,
    day_amount: round2(day_amount),
    ot_amount: round2(ot_amount),
    piece_amount: round2(piece_amount),
    total: round2(day_amount + ot_amount + piece_amount),
    byProject,
    missing_rate,
  };
}

// ---------------------------------------------------------------------------
// labour_tx (C4, C5)
// ---------------------------------------------------------------------------
export function loadTx(): LabourTx[] {
  return readJSON<LabourTx[]>(TX_KEY, []);
}

function saveTx(list: LabourTx[]) {
  writeJSON(TX_KEY, list);
  emitChange();
}

function makeTx(input: Omit<LabourTx, 'id' | 'bs_year' | 'bs_month' | 'bs_day'>): LabourTx {
  const bs = bsFromAD(input.date);
  return {
    ...input,
    id: `LT-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    bs_year: bs.year,
    bs_month: bs.month,
    bs_day: bs.day,
    amount: round2(input.amount),
  };
}

export function txInPeriod(p: BSPeriod): LabourTx[] {
  return loadTx().filter((t) => t.bs_year === p.year && t.bs_month === p.month);
}

/**
 * C4: an advance posts through booksService.saveEntry('worker-advance') —
 * Dr worker balance · Cr cash/bank (S3.2) — and settles the statement.
 * The hopper's Worker-advance type routes through this same function.
 */
export function postAdvance(input: {
  worker_id: string;
  date: string;
  amount: number;
  project_id?: string;
  note?: string;
  method?: 'cash' | 'bank'; // hopper form can override the worker default
  ref?: string;
}): { tx: LabourTx; voucher: string } {
  const worker = getWorker(input.worker_id);
  if (!worker) throw new Error(`Worker ${input.worker_id} not found.`);
  const amount = round2(input.amount);
  if (!(amount > 0)) throw new Error('Advance amount must be positive.');
  const entry = saveEntry(
    'worker-advance',
    {
      date: input.date,
      amount,
      method: input.method || worker.payment_method,
      worker_id: input.worker_id,
      worker_name: worker.name,
      ref: input.ref || '',
      note: input.note || `Advance — ${worker.name}`,
    },
    { source: 'manual' } // advances are entered via the hopper type only (S5.1)
  );
  const tx = makeTx({
    worker_id: input.worker_id,
    date: input.date,
    type: 'advance',
    amount,
    project_id: input.project_id || '',
    ref: entry.id,
    main_voucher_id: entry.id,
    note: input.note || '',
  });
  saveTx([...loadTx(), tx]);
  return { tx, voucher: entry.id };
}

/** Deductions / bonuses adjust the payable — no cash moves (F3: no ledger row). */
export function postNonCashTx(input: {
  worker_id: string;
  date: string;
  type: 'deduction' | 'bonus';
  amount: number;
  project_id?: string;
  note?: string;
}): LabourTx {
  const amount = round2(input.amount);
  if (!(amount > 0)) throw new Error('Amount must be positive.');
  const tx = makeTx({
    worker_id: input.worker_id,
    date: input.date,
    type: input.type,
    amount,
    project_id: input.project_id || '',
    ref: '',
    main_voucher_id: '',
    note: input.note || '',
  });
  saveTx([...loadTx(), tx]);
  return tx;
}

// ---------------------------------------------------------------------------
// Payroll runs (C6)
// ---------------------------------------------------------------------------
export function loadRuns(): PayrollRun[] {
  return readJSON<PayrollRun[]>(RUNS_KEY, []);
}

function saveRuns(runs: PayrollRun[]) {
  writeJSON(RUNS_KEY, runs);
  emitChange();
}

function allocate(earned: number, payable: number, byProject: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  if (payable <= 0) return out;
  if (earned <= 0) {
    out['general'] = round2(payable);
    return out;
  }
  const keys = Object.keys(byProject);
  let assigned = 0;
  keys.forEach((k, i) => {
    const share =
      i === keys.length - 1 ? round2(payable - assigned) : round2((byProject[k] / earned) * payable);
    assigned = round2(assigned + share);
    if (share !== 0) out[k] = share;
  });
  return out;
}

/** Compute net pay per worker for a B.S. period from attendance + labour_tx. */
export function computeRunTotals(p: BSPeriod): RunTotals {
  const workers = loadWorkers();
  const attendance = loadAttendance().filter((r) => inPeriod(r.date, p));
  const txs = txInPeriod(p);
  const perWorker: WorkerNet[] = [];
  const ids = new Set<string>([
    ...attendance.map((r) => r.worker_id),
    ...txs.filter((t) => t.type !== 'earning').map((t) => t.worker_id),
  ]);

  for (const id of ids) {
    const worker = workers.find((w) => w.id === id);
    if (!worker) continue;
    const earn = computeEarnings(
      worker,
      attendance.filter((r) => r.worker_id === id)
    );
    const own = txs.filter((t) => t.worker_id === id);
    const advances = round2(own.filter((t) => t.type === 'advance').reduce((s, t) => s + t.amount, 0));
    const deductions = round2(own.filter((t) => t.type === 'deduction').reduce((s, t) => s + t.amount, 0));
    const bonuses = round2(own.filter((t) => t.type === 'bonus').reduce((s, t) => s + t.amount, 0));
    const net = round2(earn.total + bonuses - advances - deductions);
    perWorker.push({
      worker_id: id,
      earned: earn.total,
      advances,
      deductions,
      bonuses,
      net,
      payable: net > 0 ? net : 0,
      carry: net < 0 ? net : 0,
      byProject: earn.byProject,
    });
  }

  const byMethod: Record<string, number> = {};
  const projectSplits: Record<string, number> = {};
  let earned = 0;
  let advances = 0;
  let deductions = 0;
  let bonuses = 0;
  let payable = 0;
  for (const w of perWorker) {
    earned = round2(earned + w.earned);
    advances = round2(advances + w.advances);
    deductions = round2(deductions + w.deductions);
    bonuses = round2(bonuses + w.bonuses);
    payable = round2(payable + w.payable);
    if (w.payable > 0) {
      const worker = workers.find((x) => x.id === w.worker_id);
      const method = worker?.payment_method || 'cash';
      byMethod[method] = round2((byMethod[method] || 0) + w.payable);
      const splits = allocate(w.earned, w.payable, w.byProject);
      for (const [proj, amt] of Object.entries(splits)) {
        projectSplits[proj] = round2((projectSplits[proj] || 0) + amt);
      }
    }
  }
  return {
    earned: round2(earned),
    advances: round2(advances),
    deductions: round2(deductions),
    bonuses: round2(bonuses),
    net: round2(earned + bonuses - advances - deductions),
    payable: round2(payable),
    byMethod,
    perWorker,
    projectSplits,
  };
}

export function createDraftRun(p: BSPeriod): PayrollRun {
  const runs = loadRuns();
  if (runs.some((r) => r.bs_year === p.year && r.bs_month === p.month && r.status !== 'locked')) {
    throw new Error(`A payroll run for ${periodKey(p.year, p.month)} already exists.`);
  }
  const seq = runs.filter((r) => r.bs_year === p.year && r.bs_month === p.month).length + 1;
  const run: PayrollRun = {
    id: `PR-${periodKey(p.year, p.month)}-${String(seq).padStart(2, '0')}`,
    bs_year: p.year,
    bs_month: p.month,
    status: 'draft',
    totals_json: computeRunTotals(p),
    posted_vouchers: [],
    paid_at: null,
    created_at: new Date().toISOString(),
    approved_at: null,
    locked_at: null,
  };
  saveRuns([...runs, run]);
  return run;
}

export function approveRun(id: string): PayrollRun {
  const runs = loadRuns();
  const run = runs.find((r) => r.id === id);
  if (!run) throw new Error(`Payroll run ${id} not found.`);
  if (run.status !== 'draft') throw new Error(`Run ${id} is ${run.status}; only draft runs can be approved.`);
  const totals = computeRunTotals({ year: run.bs_year, month: run.bs_month });
  run.totals_json = totals;

  // S5.1: payroll approve → payroll-accrual auto-entry
  // (Dr labour expense per project split · Cr worker balances).
  const { from } = periodAdRange({ year: run.bs_year, month: run.bs_month });
  const workerList = loadWorkers();
  const accrualWorkers = totals.perWorker
    .filter((w) => w.payable > 0)
    .map((w) => ({
      worker_id: w.worker_id,
      name: workerList.find((x) => x.id === w.worker_id)?.name,
      amount: w.payable,
    }));
  const project_splits = Object.entries(totals.projectSplits)
    .filter(([, a]) => Number(a) > 0)
    .map(([project_id, amount]) => ({ project_id, amount }));
  const posted: string[] = [];
  if (accrualWorkers.length > 0 && project_splits.length > 0) {
    const entry = payrollAccrualEntry({ date: from, ref: run.id, workers: accrualWorkers, project_splits });
    posted.push(entry.id);
  }

  run.status = 'approved';
  run.approved_at = new Date().toISOString();
  run.posted_vouchers = posted;
  saveRuns(runs);
  return run;
}

/**
 * S5.1: On Pay, ONE payroll-payment auto-entry is created
 * (Dr worker balances · Cr bank/cash per method), plus one labour_tx
 * payment row per paid worker (statements settle to zero, G5).
 * Runs move approved → paid.
 */
export function payRun(id: string): PayrollRun {
  const runs = loadRuns();
  const run = runs.find((r) => r.id === id);
  if (!run) throw new Error(`Payroll run ${id} not found.`);
  if (run.status !== 'approved') throw new Error(`Run ${id} is ${run.status}; only approved runs can be paid.`);
  const period: BSPeriod = { year: run.bs_year, month: run.bs_month };
  const totals = computeRunTotals(period); // freshest numbers at pay time
  const { from } = periodAdRange(period);
  const label = `${String(run.bs_month).padStart(2, '0')}/${run.bs_year}`;
  const workers = loadWorkers();

  const paidWorkers = totals.perWorker
    .filter((w) => w.payable > 0)
    .map((w) => {
      const worker = workers.find((x) => x.id === w.worker_id);
      return {
        worker_id: w.worker_id,
        name: worker?.name,
        amount: w.payable,
        method: worker?.payment_method || ('cash' as const),
      };
    });
  let paymentEntryId = '';
  if (paidWorkers.length > 0) {
    const entry = payrollPaymentEntry({ date: from, ref: run.id, workers: paidWorkers, note: `Payroll ${label}` });
    paymentEntryId = entry.id;
  }

  // One labour_tx payment row per paid worker (statement settles to zero, G5).
  const txs = loadTx();
  for (const w of totals.perWorker) {
    if (w.payable <= 0) continue;
    txs.push(
      makeTx({
        worker_id: w.worker_id,
        date: from,
        type: 'payment',
        amount: w.payable,
        project_id: '',
        ref: run.id,
        main_voucher_id: paymentEntryId,
        note: `Payroll ${label}`,
      })
    );
  }
  saveTx(txs);

  run.totals_json = totals;
  run.status = 'paid';
  run.paid_at = new Date().toISOString();
  run.posted_vouchers = [...run.posted_vouchers, paymentEntryId].filter(Boolean);
  saveRuns(runs);
  return run;
}

export function lockRun(id: string): PayrollRun {
  const runs = loadRuns();
  const run = runs.find((r) => r.id === id);
  if (!run) throw new Error(`Payroll run ${id} not found.`);
  if (run.status !== 'paid') throw new Error(`Run ${id} is ${run.status}; only paid runs can be locked.`);
  run.status = 'locked';
  run.locked_at = new Date().toISOString();
  saveRuns(runs);
  return run;
}

// ---------------------------------------------------------------------------
// Worker statement (C5)
// ---------------------------------------------------------------------------
export interface StatementRow {
  date: string;
  label: string;
  project_id: string;
  amount: number; // + increases what company owes, − decreases
  kind: 'earning' | 'advance' | 'deduction' | 'bonus' | 'payment';
  voucher?: string;
}

export interface WorkerStatement {
  worker: Worker;
  rows: StatementRow[];
  opening: number;
  earned: number;
  advances: number;
  deductions: number;
  bonuses: number;
  payments: number;
  balance: number; // + company owes worker; − over-advanced (red, C5)
}

/**
 * Statement over ALL time (optionally from a period start): opening = balance
 * before the period, then earning rows (with project split), advances,
 * deductions, payments, running balance.
 */
export function workerStatement(workerId: string, fromPeriod?: BSPeriod): WorkerStatement {
  const worker = getWorker(workerId);
  if (!worker) throw new Error(`Worker ${workerId} not found.`);
  const fromISO = fromPeriod ? periodAdRange(fromPeriod).from : '0000-01-01';

  const attendance = loadAttendance().filter((r) => r.worker_id === workerId);
  const earningsRows: StatementRow[] = [];
  const byDay = new Map<string, { rows: AttendanceRow[]; date: string }>();
  for (const r of attendance) {
    const bucket = byDay.get(r.date) || { rows: [], date: r.date };
    bucket.rows.push(r);
    byDay.set(r.date, bucket);
  }
  for (const bucket of byDay.values()) {
    const earn = computeEarnings(worker, bucket.rows);
    if (earn.total > 0) {
      earningsRows.push({
        date: bucket.date,
        label: `Earnings ${earn.days}d${earn.ot_hours ? ` +${earn.ot_hours}h OT` : ''}${earn.piece_qty ? ` +${earn.piece_qty} pcs` : ''}`,
        project_id: bucket.rows[0]?.project_id || 'general',
        amount: earn.total,
        kind: 'earning',
      });
    }
  }

  const txRows: StatementRow[] = loadTx()
    .filter((t) => t.worker_id === workerId)
    .map((t) => ({
      date: t.date,
      label: t.type.charAt(0).toUpperCase() + t.type.slice(1) + (t.note ? ` — ${t.note}` : ''),
      project_id: t.project_id,
      amount: t.type === 'bonus' ? t.amount : -t.amount,
      kind: t.type as StatementRow['kind'],
      voucher: t.main_voucher_id,
    }));

  const all = [...earningsRows, ...txRows].sort((a, b) => (a.date === b.date ? a.kind.localeCompare(b.kind) : a.date < b.date ? -1 : 1));
  const balanceOf = (rows: StatementRow[]) => round2(rows.reduce((s, r) => s + r.amount, 0));

  const before = all.filter((r) => r.date < fromISO);
  const after = all.filter((r) => r.date >= fromISO);

  const sum = (kind: StatementRow['kind']) => round2(after.filter((r) => r.kind === kind).reduce((s, r) => s + Math.abs(r.amount), 0));
  return {
    worker,
    rows: after,
    opening: balanceOf(before),
    earned: round2(after.filter((r) => r.kind === 'earning').reduce((s, r) => s + r.amount, 0)),
    advances: sum('advance'),
    deductions: sum('deduction'),
    bonuses: sum('bonus'),
    payments: sum('payment'),
    balance: round2(balanceOf(before) + balanceOf(after)),
  };
}

// ---------------------------------------------------------------------------
// By Project (C7): accrued labour vs BOQ labour budget
// ---------------------------------------------------------------------------
export interface ProjectLabourRow {
  project_id: string;
  accrued: number;
  budget: number;
  variance: number;
  flag: 'over' | 'near' | 'ok';
}

export function accruedByProject(p: BSPeriod, boq?: any[]): ProjectLabourRow[] {
  const attendance = loadAttendance().filter((r) => inPeriod(r.date, p));
  const workers = loadWorkers();
  const accrued: Record<string, number> = {};
  for (const row of attendance) {
    const worker = workers.find((w) => w.id === row.worker_id);
    if (!worker) continue;
    const earn = computeEarnings(worker, [row]);
    const key = row.project_id || 'general';
    accrued[key] = round2((accrued[key] || 0) + earn.total);
  }
  const boqData = boq ?? readJSON<any[]>('contractoros_boq', []);
  const totalBudget = round2(
    (boqData || []).reduce(
      (s, section) =>
        s +
        (section?.children || []).reduce((si: number, item: any) => si + (Number(item.actualLaborCost) || 0), 0),
      0
    )
  );
  const keys = new Set([...Object.keys(accrued), 'general']);
  return [...keys].map((project_id) => {
    const a = round2(accrued[project_id] || 0);
    const budget = project_id === 'general' || Object.keys(accrued).length <= 1 ? totalBudget : 0;
    const variance = round2(a - budget);
    const flag: ProjectLabourRow['flag'] =
      budget > 0 && a > budget ? 'over' : budget > 0 && a > budget * 0.9 ? 'near' : 'ok';
    return { project_id, accrued: a, budget, variance, flag };
  });
}

/** F4: total accrued labour (all time) for Job Costing — cash stays in ledger. */
export function totalAccruedLabour(): number {
  const workers = loadWorkers();
  const attendance = loadAttendance();
  let total = 0;
  const byWorker = new Map<string, AttendanceRow[]>();
  for (const r of attendance) {
    const list = byWorker.get(r.worker_id) || [];
    list.push(r);
    byWorker.set(r.worker_id, list);
  }
  for (const [id, rows] of byWorker) {
    const worker = workers.find((w) => w.id === id);
    if (!worker) continue;
    total += computeEarnings(worker, rows).total;
  }
  return round2(total);
}

// ---------------------------------------------------------------------------
// Reconciliation (D3) + alerts (C8)
// ---------------------------------------------------------------------------
export function labourTotalsForReconciliation(): {
  advancesPosted: number;
  payrollPosted: number;
  pendingRuns: number;
} {
  const txs = loadTx();
  const advancesPosted = round2(txs.filter((t) => t.type === 'advance').reduce((s, t) => s + t.amount, 0));
  const payrollPosted = round2(txs.filter((t) => t.type === 'payment').reduce((s, t) => s + t.amount, 0));
  const pendingRuns = loadRuns().filter((r) => r.status === 'draft' || r.status === 'approved').length;
  return { advancesPosted, payrollPosted, pendingRuns };
}

export function reconcile(): Reconciliation {
  return computeReconciliation(labourTotalsForReconciliation());
}

export type Alert = {
  kind: 'over-advanced' | 'missing-rate' | 'unpaid-wage' | 'reconcile';
  severity: 'red' | 'amber';
  message: string;
  worker_id?: string;
};

/** C8: over-advanced, missing rate, unpaid > X days after payday, mismatch. */
export function alerts(p: BSPeriod, boq?: any[]): Alert[] {
  const out: Alert[] = [];
  const workers = loadWorkers();
  const attendance = loadAttendance();

  for (const w of workers) {
    const st = workerStatement(w.id, p);
    if (st.balance < 0) {
      out.push({
        kind: 'over-advanced',
        severity: 'red',
        worker_id: w.id,
        message: `${w.name} is over-advanced by ${Math.abs(st.balance).toLocaleString()}`,
      });
    }
  }

  const ids = new Set(attendance.map((r) => r.worker_id));
  for (const id of ids) {
    const worker = workers.find((w) => w.id === id);
    if (!worker || !(worker.rate > 0)) {
      out.push({
        kind: 'missing-rate',
        severity: 'amber',
        worker_id: id,
        message: `Attendance recorded for ${worker ? worker.name : id} but no rate is configured`,
      });
    }
  }

  // Unpaid net wage > X days after payday (payday = last day of the period).
  let unpaidDays = 7;
  try {
    // Payroll settings are part of this job's books.
    const s = readScoped<{ wageUnpaidDays?: unknown }>(SETTINGS_KEY, {});
    if (Number(s.wageUnpaidDays) > 0) unpaidDays = Number(s.wageUnpaidDays);
  } catch {
    /* default */
  }
  const payday = periodAdRange(p).to;
  const today = kathmanduToday();
  const daysPast = Math.floor((Date.parse(today) - Date.parse(payday)) / (24 * 3600 * 1000));
  if (daysPast > unpaidDays) {
    for (const w of loadRuns()) {
      if (w.bs_year !== p.year || w.bs_month !== p.month) continue;
      if (w.status === 'draft' || w.status === 'approved') {
        out.push({
          kind: 'unpaid-wage',
          severity: 'amber',
          message: `Payroll for ${periodKey(p.year, p.month)} is ${daysPast} days past payday (${payday}) and still ${w.status}`,
        });
      }
    }
  }

  const rec = reconcile();
  if (rec.status === 'red') {
    out.push({
      kind: 'reconcile',
      severity: 'red',
      message: `Labour reconciliation mismatch: difference ${rec.difference.toLocaleString()} (ledger ${rec.ledgerOut.toLocaleString()} vs posted ${rec.labourSide.toLocaleString()})`,
    });
  }
  void boq;
  return out;
}

// ---------------------------------------------------------------------------
// Nav helpers (D2 link icons)
// ---------------------------------------------------------------------------
export function ledgerRowsForRefId(refId: string): BooksEntry[] {
  return entriesForRef(refId);
}

export function payrollRunsForVoucher(voucher: string): PayrollRun[] {
  return loadRuns().filter((r) => r.posted_vouchers.includes(voucher) || r.id === voucher);
}
