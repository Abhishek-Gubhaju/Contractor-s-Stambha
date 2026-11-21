// ============================================================================
// ledgerService — LEGACY ledger_entries (read-only).
//
// Section 0 of the Ledger rewrite: ALL writes to this table are deleted.
// The table is kept read-only, for migration only (S0.2); it will be dropped
// in a later release after sign-off.
//
// What remains here:
//   • read-only load + in-memory normalization of legacy rows (F6),
//   • the shared category/method constants,
//   • the voucher numbering service — extended via nextInSeries() so the new
//     entry series (booksService.ENTRY_PREFIX) reuse the same machinery (KEEP),
//   • offline attachments + app-wide backup helpers,
//   • the raw-row migration primitives consumed by ledgerMigration.
// ============================================================================
import { adToBS } from '../utils/nepaliDate';
import { fiscalYearOf, BSPeriod, periodKey, prevPeriod, currentFiscalYear } from './periods';
import { readScoped, writeScoped, writeScopedStrict } from './projectScope';

export const ENTRIES_KEY = 'contractoros_ledger_entries';
export const META_KEY = 'contractoros_ledger_meta';
export const ATTACH_KEY = 'contractoros_ledger_attachments';
export const PROJECTS_KEY = 'contractoros_projects';
export const BACKUP_NUDGE_KEY = 'contractoros_backup_nudge';

export const SCHEMA_VERSION = 2;

export type LedgerType = 'receipt' | 'payment' | 'journal' | 'opening';
export type LedgerMethod = 'cash' | 'bank' | 'cheque' | 'wallet' | 'journal';
export type LedgerSource =
  | 'manual'
  | 'billing'
  | 'payroll'
  | 'labour-advance'
  | 'manual-override';
export type CounterpartyType = 'client' | 'supplier' | 'worker' | 'staff' | 'other';

export interface EditHistoryRow {
  at: string;
  reason: string;
  patch: Record<string, unknown>;
}

/** Section E: ledger_entries. */
export interface LedgerEntry {
  id: string;
  ad_date: string; // canonical A.D. date "YYYY-MM-DD"
  bs_year: number; // derived once at write (A3)
  bs_month: number;
  bs_day: number;
  voucher: string; // RV / PV / JV per fiscal year
  type: LedgerType;
  counterparty: string;
  counterparty_type: CounterpartyType | '';
  project_id: string;
  category: string;
  ref: string;
  qty: number;
  unit: string;
  rate: number;
  method: LedgerMethod;
  cash_in: number;
  cash_out: number;
  expense: number;
  billed: number;
  settled: number;
  outstanding: number;
  source: LedgerSource;
  ref_id: string;
  attachment_path: string;
  note: string;
  created_at: string;
  edited_history: EditHistoryRow[];
}

export interface AuditRow {
  at: string;
  action: 'lock' | 'unlock' | 'edit' | 'delete' | 'opening' | 'post' | 'backup';
  period?: string;
  target?: string;
  reason: string;
}

export interface LedgerMeta {
  schema_version: number;
  locks: Record<string, { locked_at: string; reason: string }>;
  openings: Record<string, { cash?: number; bank?: number }>;
  audit: AuditRow[];
}

/** Shared category list (D5). */
export const LEDGER_CATEGORIES = [
  'Client Receipt',
  'Materials',
  'Transport',
  'Labour',
  'Subcontractor',
  'Rent',
  'Utilities',
  'Office',
  'Travel',
  'Entertainment',
  'Repairs & Maintenance',
  'Equipment',
  'Taxes',
  'Interest',
  'Salary',
  'Others',
];

export const LEDGER_METHODS: LedgerMethod[] = ['cash', 'bank', 'cheque', 'wallet', 'journal'];

/** Labour-origin sources: the Ledger may never edit these (D1, F5, G4). */
export const LABOUR_SOURCES: LedgerSource[] = ['payroll', 'labour-advance'];

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

// Legacy tables, their meta and their attachment blobs are read under the job
// that owns them: an old job's registers never surface in a new job.
function readJSON<T>(key: string, fallback: T): T {
  return readScoped<T>(key, fallback);
}

// ---------------------------------------------------------------------------
// Meta — READ-ONLY (migration carries locks/openings/audit into books meta)
// ---------------------------------------------------------------------------
export function loadMeta(): LedgerMeta {
  const meta = readJSON<Partial<LedgerMeta>>(META_KEY, {});
  return {
    schema_version: meta.schema_version ?? SCHEMA_VERSION,
    locks: meta.locks ?? {},
    openings: meta.openings ?? {},
    audit: meta.audit ?? [],
  };
}

// ---------------------------------------------------------------------------
// Migration primitives (F6 — convert, never drop). Read-only: normalization
// happens in memory; the raw table is never rewritten (S0.2).
// ---------------------------------------------------------------------------
export function legacyCategoryToMethod(category: string, txType: string): LedgerMethod {
  if (/bank/i.test(category)) return 'bank';
  if (/cheque/i.test(category)) return 'cheque';
  if (txType === 'Opening') return 'cash';
  return 'cash';
}

export function isLegacyRow(row: Record<string, unknown>): boolean {
  return typeof row.transactionDate !== 'undefined' || typeof row.accountCategory !== 'undefined';
}

/**
 * Parse a calendar date "YYYY-MM-DD" into an instant the library will read as
 * THAT Kathmandu day: noon UTC is always the same calendar day in Asia/
 * Kathmandu (17:45 local), independent of the machine's timezone.
 */
export function safeBs(adDate: string): { year: number; month: number; day: number } {
  try {
    const d = String(adDate).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { year: 0, month: 0, day: 0 };
    return adToBS(
      new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)), 12))
    );
  } catch {
    return { year: 0, month: 0, day: 0 };
  }
}

export function migrateLegacyRow(row: any, index: number): LedgerEntry {
  const adDate = String(row.transactionDate || row.ad_date || '').slice(0, 10);
  const bs = safeBs(adDate);
  const amount = round2(row.amount ?? 0);
  const isDebit = String(row.transactionType || '').toLowerCase() === 'debit';
  const isOpening = String(row.transactionType || '').toLowerCase() === 'opening';
  const category = row.accountCategory || 'Others';
  const method = legacyCategoryToMethod(category, String(row.transactionType || ''));
  const type: LedgerType = isOpening ? 'opening' : isDebit ? 'receipt' : 'payment';
  const balanceAfter = round2(row.balanceAfter ?? 0);
  return {
    id: String(row.id || `MIG-${index}`),
    ad_date: adDate,
    bs_year: row.bsYear ?? bs.year,
    bs_month: row.bsMonth ?? bs.month,
    bs_day: row.bsDay ?? bs.day,
    voucher: String(row.voucher || row.id || ''),
    type,
    counterparty: String(row.codeOrName || row.counterparty || ''),
    counterparty_type: '',
    project_id: '',
    category,
    ref: '',
    qty: 0,
    unit: '',
    rate: 0,
    method,
    cash_in: isOpening || isDebit ? amount : 0,
    cash_out: !isOpening && !isDebit ? amount : 0,
    expense: !isOpening && !isDebit ? amount : 0,
    billed: 0,
    settled: isDebit ? amount : 0,
    outstanding: 0,
    source: 'manual',
    ref_id: '',
    attachment_path: String(row.attachment_path || ''),
    note: String(row.comment || row.note || ''),
    created_at: row.created_at || new Date().toISOString(),
    edited_history: [],
    // balanceAfter of legacy opening rows is the opening seed for statements.
    ...(isOpening ? { _legacy_balance: balanceAfter } : {}),
  } as LedgerEntry;
}

/**
 * READ-ONLY load: rows are normalized IN MEMORY (legacy shape → Section E,
 * missing B.S. integers topped up). Nothing is ever written back (S0.2).
 */
export function loadEntries(): LedgerEntry[] {
  const raw = readJSON<any[]>(ENTRIES_KEY, []);
  return raw.map((row, i) => {
    if (!row) return row;
    if (isLegacyRow(row)) return migrateLegacyRow(row, i);
    if (typeof row.bs_year !== 'number' && row.ad_date) {
      const d = String(row.ad_date).slice(0, 10);
      const bs = safeBs(d);
      return { ...row, bs_year: bs.year, bs_month: bs.month, bs_day: bs.day };
    }
    return row;
  });
}

/** Which cash/bank account a legacy method maps to (parity semantics, S1.3). */
export function legacyAccountOf(method: LedgerMethod | string): 'cash' | 'bank' | null {
  const m = String(method || '');
  if (m === 'cash' || m === 'wallet') return 'cash';
  if (m === 'bank' || m === 'cheque') return 'bank';
  return null; // journal — no cash account
}

// ---------------------------------------------------------------------------
// Voucher numbering (B2, D5) — the shared service, extended with new series
// ---------------------------------------------------------------------------
const TYPE_PREFIX: Record<string, string> = {
  receipt: 'RV',
  payment: 'PV',
  journal: 'JV',
  opening: 'OB',
};

export function voucherPrefix(type: LedgerType): string {
  return TYPE_PREFIX[type] || 'JV';
}

/**
 * Generic per-fiscal-year sequence — the extension point every series uses
 * (legacy RV/PV/JV AND the new SB/PS/CR/CI/EX/WA/TR/OI/AJ/PA/PP series).
 */
export function nextInSeries(prefix: string, vouchers: string[]): string {
  let max = 0;
  for (const v of vouchers) {
    const s = String(v || '');
    if (!s.startsWith(prefix)) continue;
    const n = Number(s.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

/** Next legacy voucher no. for the fiscal year containing `adDate`. */
export function nextVoucher(type: LedgerType, adDate: string, entries?: LedgerEntry[]): string {
  const list = entries ?? loadEntries();
  const bs = safeBs(adDate);
  const fy = fiscalYearOf(bs.year, bs.month);
  return nextInSeries(`${voucherPrefix(type)}-${fy.label}-`, list.map((e) => String(e.voucher || '')));
}

// ---------------------------------------------------------------------------
// Attachments (B2, G7) — stored offline; the entry keeps the path, which
// survives restarts because both live in localStorage.
// ---------------------------------------------------------------------------
export function saveAttachment(fileName: string, dataUrl: string): string {
  const safe = String(fileName || 'file').replace(/[^\w.\-]+/g, '_');
  const store = readJSON<Record<string, string>>(ATTACH_KEY, {});
  let path = `data/ledger/attachments/${safe}`;
  let i = 1;
  while (store[path]) {
    path = `data/ledger/attachments/${i++}_${safe}`;
  }
  store[path] = dataUrl;
  writeScopedStrict(ATTACH_KEY, store);
  return path;
}

export function readAttachment(path: string): string | null {
  const store = readJSON<Record<string, string>>(ATTACH_KEY, {});
  return store[path] ?? null;
}

// ---------------------------------------------------------------------------
// Backup (B6: nudge on first open of a new month) + full snapshot export
// ---------------------------------------------------------------------------
export function backupSnapshot(): string {
  const dump: Record<string, unknown> = {
    exported_at: new Date().toISOString(),
  };
  // Credentials never travel inside a backup: a hash file is a cracking target,
  // and a restored copy must not be able to re-create someone's sign-in.
  const skip = new Set(['contractoros_auth_users', 'contractoros_auth_log', 'contractoros_auth_session']);
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('contractoros_') && !skip.has(k)) {
      try {
        dump[k] = JSON.parse(localStorage.getItem(k) as string);
      } catch {
        dump[k] = localStorage.getItem(k);
      }
    }
  }
  return JSON.stringify(dump, null, 2);
}

export function downloadBackup() {
  const blob = new Blob([backupSnapshot()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `contractoros_backup_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Returns true the first time the app opens a period newer than the last one
 * seen, so the page can nudge for a backup (B6). Result is persisted.
 */
export function checkBackupNudge(current: BSPeriod): boolean {
  const key = periodKey(current.year, current.month);
  const last = readJSON<{ period?: string } | null>(BACKUP_NUDGE_KEY, null);
  if (last && last.period === key) return false;
  const show = Boolean(last); // don't nudge the very first run, only on change
  writeScoped(BACKUP_NUDGE_KEY, { period: key });
  return show;
}

/** Fiscal year helper re-export (legacy callers). */
export function fiscalYearNow(): string {
  return currentFiscalYear().label;
}

/** Previous-period helper (legacy callers). */
export function previousPeriod(p: BSPeriod): BSPeriod {
  return prevPeriod(p);
}
