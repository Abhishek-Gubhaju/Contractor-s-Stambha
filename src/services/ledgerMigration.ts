// ============================================================================
// ledgerMigration — Section 1: migrate the legacy ledger_entries table into
// the new double-entry books (entries + entry_lines).
//
//   S1.1  full backup of the legacy tables before anything else runs,
//   S1.2  every legacy row → one entry + its lines, with inferred type
//         (receipt / payment / journal): category → expense account,
//         method → cash/bank account, AD date + local-calendar integers,
//         reference, attachment path and source badge all preserved,
//   S1.3  parity report per period: legacy closing cash & bank == new
//         Daybook closing, Σdebits == Σcredits, row counts reconciled.
//         The release (and the migration itself) is blocked until green.
//
// The legacy table is never written (read-only, S0.2). The migration is
// idempotent: guarded by books meta.migrated_at, with a rollback path if the
// parity check fails.
// ============================================================================
import { BSPeriod, periodAdRange, periodKey } from './periods';
import {
  ENTRIES_KEY as LEGACY_ENTRIES_KEY,
  META_KEY as LEGACY_META_KEY,
  ATTACH_KEY as LEGACY_ATTACH_KEY,
  LedgerEntry,
  LedgerMeta,
  LedgerMethod,
  isLegacyRow,
  loadEntries as loadLegacyEntries,
  loadMeta as loadLegacyMeta,
  legacyAccountOf,
  migrateLegacyRow,
  safeBs,
} from './ledgerService';
import {
  ENTRIES_KEY,
  ENTRY_LINES_KEY,
  BILL_LINKS_KEY,
  Account,
  Entry,
  EntryLine,
  EntrySource,
  EntryType,
  ensureAccount,
  expenseAccountId,
  loadMeta,
  saveMeta,
  allEntries,
  allLines,
  loadBillLinks,
  BOOKS_META_KEY,
} from './booksService';
import { keyFor, readScoped, writeScoped } from './projectScope';

export const LEGACY_BACKUP_KEY = 'contractoros_legacy_backup';

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

// Migration reads and writes the ACTIVE job's books and that job's legacy
// tables — never another job's copy.
function readJSON<T>(key: string, fallback: T): T {
  return readScoped<T>(key, fallback);
}
function writeJSON(key: string, value: unknown) {
  writeScoped(key, value);
}

// ---------------------------------------------------------------------------
// S1.1 — full backup of the legacy tables
// ---------------------------------------------------------------------------
export interface LegacyBackup {
  exported_at: string;
  contractoros_ledger_entries: unknown[];
  contractoros_ledger_meta: LedgerMeta | Record<string, never>;
  contractoros_ledger_attachments: Record<string, string>;
}

export function legacyBackupSnapshot(): LegacyBackup {
  return {
    exported_at: new Date().toISOString(),
    contractoros_ledger_entries: readJSON<unknown[]>(LEGACY_ENTRIES_KEY, []),
    contractoros_ledger_meta: readJSON<LegacyBackup['contractoros_ledger_meta']>(LEGACY_META_KEY, {} as never),
    contractoros_ledger_attachments: readJSON<Record<string, string>>(LEGACY_ATTACH_KEY, {}),
  };
}

export function legacyBackupJson(): string {
  return JSON.stringify(legacyBackupSnapshot(), null, 2);
}

export function downloadLegacyBackup() {
  const blob = new Blob([legacyBackupJson()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `contractoros_legacy_backup_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// S1.2 — convert legacy rows → entries + entry_lines
// ---------------------------------------------------------------------------
const CASH_LIKE_CATEGORY = /^(cash|bank|wallet|cheque|opening balance)$/i;

function sourceBadge(source: string): EntrySource {
  if (source === 'payroll' || source === 'labour-advance') return 'payroll';
  if (source === 'billing') return 'billing';
  return 'manual';
}

function counterAccountFor(category: string, isOpening: boolean): string {
  if (isOpening) return 'acc:opening';
  if (!category || CASH_LIKE_CATEGORY.test(category.trim())) return 'acc:conversion';
  if (/^client receipt$/i.test(category.trim())) return 'acc:income';
  ensureAccount(expenseAccountId(category), category, 'expense');
  return expenseAccountId(category);
}

interface DraftConverted {
  entry: Entry;
  lines: Omit<EntryLine, 'id' | 'entry_id'>[];
}

function convertRow(norm: LedgerEntry, rawIndex: number, usedIds: Set<string>): DraftConverted {
  const adDate = String(norm.ad_date || '').slice(0, 10);
  const bs = norm.bs_year ? { year: norm.bs_year, month: norm.bs_month, day: norm.bs_day } : safeBs(adDate);
  const isOpening = norm.type === 'opening';
  const cashAcc = legacyAccountOf(norm.method as LedgerMethod | string);
  const cashIn = round2(norm.cash_in || 0);
  const cashOut = round2(norm.cash_out || 0);
  const amount = round2(cashIn > 0 ? cashIn : cashOut > 0 ? cashOut : norm.expense || 0);

  const category = norm.category || 'Others';
  const counter = counterAccountFor(category, isOpening);

  // S1.2 inferred type: cash leg → receipt/payment, else journal.
  let type: EntryType;
  if (cashIn > 0) type = 'receipt';
  else if (cashOut > 0) type = 'payment';
  else type = 'journal';

  let lineDefs: Omit<EntryLine, 'id' | 'entry_id'>[];
  if (cashAcc && amount > 0) {
    const cashId = cashAcc === 'bank' ? 'acc:bank' : 'acc:cash';
    const counterId = counter === cashId ? 'acc:conversion' : counter;
    lineDefs =
      type === 'receipt'
        ? [
            { account_id: cashId, party_id: '', worker_id: '', project_id: norm.project_id || '', cost_code: '', debit: amount, credit: 0, memo: norm.note || 'Migrated receipt', bill_link_id: '' },
            { account_id: counterId, party_id: norm.counterparty || '', worker_id: '', project_id: norm.project_id || '', cost_code: category, debit: 0, credit: amount, memo: `Migrated: ${category}`, bill_link_id: '' },
          ]
        : [
            { account_id: counterId, party_id: norm.counterparty || '', worker_id: '', project_id: norm.project_id || '', cost_code: category, debit: amount, credit: 0, memo: `Migrated: ${category}`, bill_link_id: '' },
            { account_id: cashId, party_id: '', worker_id: '', project_id: norm.project_id || '', cost_code: '', debit: 0, credit: amount, memo: norm.note || 'Migrated payment', bill_link_id: '' },
          ];
  } else {
    // No cash leg (journal / opening without method): balance against conversion.
    lineDefs =
      type === 'receipt'
        ? [
            { account_id: 'acc:conversion', party_id: '', worker_id: '', project_id: '', cost_code: '', debit: amount, credit: 0, memo: 'Migrated journal', bill_link_id: '' },
            { account_id: counter, party_id: norm.counterparty || '', worker_id: '', project_id: norm.project_id || '', cost_code: category, debit: 0, credit: amount, memo: `Migrated: ${category}`, bill_link_id: '' },
          ]
        : [
            { account_id: counter, party_id: norm.counterparty || '', worker_id: '', project_id: norm.project_id || '', cost_code: category, debit: amount, credit: 0, memo: `Migrated: ${category}`, bill_link_id: '' },
            { account_id: 'acc:conversion', party_id: '', worker_id: '', project_id: '', cost_code: '', debit: 0, credit: amount, memo: 'Migrated journal', bill_link_id: '' },
          ];
  }

  // Preserve the legacy voucher as the new entry id (S1.2), deduped.
  let id = String(norm.voucher || norm.id || `MIG-${rawIndex}`);
  let n = 1;
  while (usedIds.has(id)) id = `${id}#${++n}`;
  usedIds.add(id);

  const entry: Entry = {
    id,
    type,
    ad_date: adDate,
    bs_y: bs.year,
    bs_m: bs.month,
    bs_d: bs.day,
    ref: norm.ref || '',
    note: norm.note || '',
    attachment: norm.attachment_path || '',
    source: sourceBadge(norm.source || 'manual'),
    created_at: norm.created_at || new Date().toISOString(),
    edited_history: [],
  };
  return { entry, lines: lineDefs };
}

/** Meta openings (explicit opening balances) become opening entries. */
function convertMetaOpenings(meta: LedgerMeta): DraftConverted[] {
  const out: DraftConverted[] = [];
  for (const [pKey, accounts] of Object.entries(meta.openings || {})) {
    const [ys, ms] = pKey.split('-');
    const year = Number(ys);
    const month = Number(ms);
    if (!Number.isInteger(year) || !Number.isInteger(month)) continue;
    const bs = { year, month, day: 1 };
    const adDate = periodAdRange({ year, month } as BSPeriod).from;
    for (const [acct, amount] of Object.entries(accounts || {})) {
      const value = round2(Number(amount) || 0);
      if (!(value > 0)) continue;
      const cashId = acct === 'bank' ? 'acc:bank' : 'acc:cash';
      out.push({
        entry: {
          id: `OB-META-${pKey}-${acct}`,
          type: 'receipt',
          ad_date: adDate,
          bs_y: bs.year,
          bs_m: bs.month,
          bs_d: bs.day,
          ref: '',
          note: `Opening balance (${acct}) migrated from legacy meta`,
          attachment: '',
          source: 'manual',
          created_at: new Date().toISOString(),
          edited_history: [],
        },
        lines: [
          { account_id: cashId, party_id: '', worker_id: '', project_id: '', cost_code: '', debit: value, credit: 0, memo: 'Opening balance', bill_link_id: '' },
          { account_id: 'acc:opening', party_id: '', worker_id: '', project_id: '', cost_code: '', debit: 0, credit: value, memo: 'Opening balance', bill_link_id: '' },
        ],
      });
    }
  }
  return out;
}

export interface Conversion {
  entries: Entry[];
  lines: EntryLine[];
  rowEntryIds: string[]; // ids that came from legacy rows (for count parity)
  metaOpeningIds: string[];
  rowCount: number;
}

export function convertLegacy(): Conversion {
  const rawRows = readJSON<any[]>(LEGACY_ENTRIES_KEY, []);
  const legacyNorm: LedgerEntry[] = rawRows.map((row, i) => {
    if (!row) return null;
    if (isLegacyRow(row)) return migrateLegacyRow(row, i);
    if (typeof row.bs_year !== 'number' && row.ad_date) {
      const bs = safeBs(String(row.ad_date).slice(0, 10));
      return { ...row, bs_year: bs.year, bs_month: bs.month, bs_day: bs.day };
    }
    return row;
  }).filter(Boolean) as LedgerEntry[];

  const usedIds = new Set<string>(allEntries().map((e) => e.id));
  const entries: Entry[] = [];
  const lines: EntryLine[] = [];
  const rowEntryIds: string[] = [];

  legacyNorm.forEach((norm, i) => {
    const { entry, lines: defs } = convertRow(norm, i, usedIds);
    entries.push(entry);
    rowEntryIds.push(entry.id);
    defs.forEach((d, j) => lines.push({ ...d, id: `${entry.id}#${j + 1}`, entry_id: entry.id }));
  });

  const metaOpenings = convertMetaOpenings(loadLegacyMeta());
  const metaOpeningIds: string[] = [];
  for (const { entry, lines: defs } of metaOpenings) {
    if (usedIds.has(entry.id)) continue;
    usedIds.add(entry.id);
    entries.push(entry);
    metaOpeningIds.push(entry.id);
    defs.forEach((d, j) => lines.push({ ...d, id: `${entry.id}#${j + 1}`, entry_id: entry.id }));
  }

  return { entries, lines, rowEntryIds, metaOpeningIds, rowCount: legacyNorm.length };
}

// ---------------------------------------------------------------------------
// S1.3 — parity report (release blocked until green)
// ---------------------------------------------------------------------------
export interface ParityPeriod {
  period: string;
  legacyCash: { cash: number; bank: number };
  newCash: { cash: number; bank: number };
  legacyRows: number;
  migratedEntries: number;
  debits: number;
  credits: number;
  green: boolean;
}

export interface ParityReport {
  periods: ParityPeriod[];
  totalLegacyRows: number;
  totalMigratedEntries: number;
  totalDebits: number;
  totalCredits: number;
  balanced: boolean;
  countsMatch: boolean;
  closingsMatch: boolean;
  green: boolean;
}

const EPS = 0.005;

/** Legacy side of the parity equation — computed from the legacy table only. */
function legacyCashThrough(rows: LedgerEntry[], metaOpenings: Record<string, { cash?: number; bank?: number }>, to: string): { cash: number; bank: number } {
  let cash = 0;
  let bank = 0;
  for (const r of rows) {
    const d = String(r.ad_date || '').slice(0, 10);
    if (!d || d > to) continue;
    const acc = legacyAccountOf(r.method as LedgerMethod | string);
    const delta = round2((r.cash_in || 0) - (r.cash_out || 0));
    if (acc === 'cash') cash = round2(cash + delta);
    if (acc === 'bank') bank = round2(bank + delta);
  }
  for (const [pKey, accounts] of Object.entries(metaOpenings || {})) {
    // include openings whose period starts at or before `to`
    const adFrom = periodAdRange({ year: Number(pKey.split('-')[0]), month: Number(pKey.split('-')[1]) } as BSPeriod).from;
    if (adFrom > to) continue;
    cash = round2(cash + round2(Number(accounts?.cash) || 0));
    bank = round2(bank + round2(Number(accounts?.bank) || 0));
  }
  return { cash, bank };
}

export function parityReport(): ParityReport {
  const legacyRows = loadLegacyEntries();
  const metaOpenings = loadLegacyMeta().openings || {};
  const books = loadMeta();
  const migratedIds = new Set(books.migrated_entry_ids);
  const allE = allEntries().filter((e) => migratedIds.has(e.id));
  const allL = allLines().filter((l) => migratedIds.has(l.entry_id));
  const rowDerived = allE.filter((e) => !e.id.startsWith('OB-META-'));

  // distinct periods (B.S.) present in legacy rows, sorted
  const periodSet = new Set<string>();
  for (const r of legacyRows) {
    const bs = r.bs_year ? { year: r.bs_year, month: r.bs_month } : safeBs(r.ad_date);
    if (bs.year) periodSet.add(periodKey(bs.year, bs.month));
  }
  for (const pKey of Object.keys(metaOpenings)) periodSet.add(pKey);
  const periodsSorted = [...periodSet].sort();

  const periods: ParityPeriod[] = periodsSorted.map((pKey) => {
    const [ys, ms] = pKey.split('-');
    const p = { year: Number(ys), month: Number(ms) } as BSPeriod;
    const to = periodAdRange(p).to;

    const legacy = legacyCashThrough(legacyRows, metaOpenings, to);
    const newSide = { cash: 0, bank: 0 };
    for (const e of allE) {
      if (e.ad_date > to) continue;
      for (const l of allL) {
        if (l.entry_id !== e.id) continue;
        if (l.account_id === 'acc:cash') newSide.cash = round2(newSide.cash + l.debit - l.credit);
        if (l.account_id === 'acc:bank') newSide.bank = round2(newSide.bank + l.debit - l.credit);
      }
    }
    const legacyRowsIn = legacyRows.filter((r) => {
      const d = String(r.ad_date || '').slice(0, 10);
      return d && d <= to;
    }).length;
    const migratedIn = rowDerived.filter((e) => e.ad_date <= to).length;
    const debits = round2(allL.filter((l) => allE.some((e) => e.id === l.entry_id && e.ad_date <= to)).reduce((s, l) => s + l.debit, 0));
    const credits = round2(allL.filter((l) => allE.some((e) => e.id === l.entry_id && e.ad_date <= to)).reduce((s, l) => s + l.credit, 0));

    const closingsOk =
      Math.abs(legacy.cash - newSide.cash) < EPS && Math.abs(legacy.bank - newSide.bank) < EPS;
    return {
      period: pKey,
      legacyCash: legacy,
      newCash: newSide,
      legacyRows: legacyRowsIn,
      migratedEntries: migratedIn,
      debits,
      credits,
      green: closingsOk && legacyRowsIn === migratedIn && Math.abs(debits - credits) < EPS,
    };
  });

  const totalDebits = round2(allL.reduce((s, l) => s + l.debit, 0));
  const totalCredits = round2(allL.reduce((s, l) => s + l.credit, 0));
  const countsMatch = legacyRows.length === rowDerived.length;
  const closingsMatch = periods.every((p) => Math.abs(p.legacyCash.cash - p.newCash.cash) < EPS && Math.abs(p.legacyCash.bank - p.newCash.bank) < EPS);
  const balanced = Math.abs(totalDebits - totalCredits) < EPS;
  const green = balanced && countsMatch && closingsMatch && periods.every((p) => p.green);

  return {
    periods,
    totalLegacyRows: legacyRows.length,
    totalMigratedEntries: rowDerived.length,
    totalDebits,
    totalCredits,
    balanced,
    countsMatch,
    closingsMatch,
    green,
  };
}

// ---------------------------------------------------------------------------
// runMigration — backup → convert → write → parity gate (idempotent)
// ---------------------------------------------------------------------------
export interface MigrationResult {
  ran: boolean;
  skipped: boolean;
  migrated: number;
  green: boolean;
  error?: string;
  report: ParityReport | null;
}

export function runMigration(): MigrationResult {
  const meta = loadMeta();
  if (meta.migrated_at) {
    return { ran: false, skipped: true, migrated: 0, green: parityReport().green, report: parityReport() };
  }

  // S1.1 backup FIRST — persisted locally and downloadable.
  writeJSON(LEGACY_BACKUP_KEY, legacyBackupSnapshot());

  const conversion = convertLegacy();
  // Capture the exact physical keys used below: a rollback must restore the
  // same store the migration wrote, not a differently-scoped one.
  const prevKeys = {
    entries: keyFor(ENTRIES_KEY),
    lines: keyFor(ENTRY_LINES_KEY),
    links: keyFor(BILL_LINKS_KEY),
    meta: keyFor(BOOKS_META_KEY),
  };
  const prev = {
    entries: localStorage.getItem(prevKeys.entries),
    lines: localStorage.getItem(prevKeys.lines),
    links: localStorage.getItem(prevKeys.links),
    meta: localStorage.getItem(prevKeys.meta),
  };
  const rollback = () => {
    const put = (key: string, value: string | null) => {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    };
    put(prevKeys.entries, prev.entries);
    put(prevKeys.lines, prev.lines);
    put(prevKeys.links, prev.links);
    put(prevKeys.meta, prev.meta);
  };

  const mergedEntries = [...allEntries(), ...conversion.entries];
  const mergedLines = [...allLines(), ...conversion.lines];
  const allMigratedIds = [...conversion.rowEntryIds, ...conversion.metaOpeningIds];

  try {
    writeJSON(ENTRIES_KEY, mergedEntries);
    writeJSON(ENTRY_LINES_KEY, mergedLines);
    const nextMeta = { ...meta, migrated_entry_ids: allMigratedIds };
    writeJSON(BOOKS_META_KEY, nextMeta);
  } catch (err) {
    // roll back everything
    rollback();
    return { ran: false, skipped: false, migrated: 0, green: false, error: String(err), report: null };
  }

  const report = parityReport();
  if (!report.green) {
    // S1.3 release is blocked until green — roll back the migration.
    rollback();
    return {
      ran: false,
      skipped: false,
      migrated: 0,
      green: false,
      error: 'Parity report is NOT green — migration rolled back, release blocked.',
      report,
    };
  }

  const finalMeta = loadMeta();
  finalMeta.migrated_at = new Date().toISOString();
  finalMeta.migrated_entry_ids = allMigratedIds;
  finalMeta.audit = [...finalMeta.audit, { at: new Date().toISOString(), action: 'migration' as const, reason: `Migrated ${conversion.rowEntryIds.length} legacy rows (parity green)`, target: 'ledger_entries' }].slice(-500);
  saveMeta(finalMeta);

  return { ran: true, skipped: false, migrated: conversion.rowEntryIds.length, green: true, report };
}

/** Convenience for the Controls bar: has the migration run & is it green? */
export function migrationStatus(): { migrated: boolean; green: boolean; rows: number } {
  const meta = loadMeta();
  const report = parityReport();
  return { migrated: Boolean(meta.migrated_at), green: report.green, rows: report.totalLegacyRows };
}
