// ============================================================================
// booksService — the double-entry core of the new Ledger module (Section 2).
//
// Terminology note: the spec's "capture" is an ENTRY — this module and its
// storage use "entry" / "entry_lines" throughout.
//
// • ONE line table (entry_lines); every view derives from it (S4).
// • Posting engine: PURE recipe(type, form) → lines[]. The hopper's live
//   routing preview AND the save action call this SAME function (S2.3).
//   Preview == truth.
// • Dates only via utils/nepaliDate; canonical AD + local-calendar integers
//   stored on the entry at write time (S2.4).
// • Locked periods reject entries and edits; unlock requires a reason in the
//   audit log (S6.1). Voucher series per type per fiscal year (S6.2).
// • Fully offline: localStorage only, zero network (S6.4).
// ============================================================================
import { adToBS } from '../utils/nepaliDate';
import { fiscalYearOf, periodKey, BSPeriod, periodAdRange } from './periods';
import { LEDGER_CATEGORIES, nextInSeries } from './ledgerService';
import { committedByKey } from './commitments';
import { taxBreakdown } from './taxService';
import {
  BOQ_PROJECT_ID,
  costCodeOf,
  ensureCostCode,
  ensureProject,
  loadBoqItems,
  loadCostCodes,
  loadProjects,
  projectNameOf,
  contractValueOf,
  estimatedCostOf,
  LABOUR_EXPENSE_CATEGORIES,
  isLabourCategory,
  type CostCodeKind,
} from './masterData';

// Labour categories live in masterData so the posting engine and the cost-code
// master cannot drift apart. Re-exported to keep the existing public API.
export { LABOUR_EXPENSE_CATEGORIES, isLabourCategory } from './masterData';

import { DEFAULT_PROJECT_ID, getActiveProject, readScoped, writeScoped, writeScopedStrict } from './projectScope';
import { ensureParty } from './partyService';
import {
  documentsForEntry,
  linkDocument,
  removeDocument,
  storeDocument,
  unlinkEntryDocuments,
  type AttachmentInput,
} from './attachmentService';
import {
  documentTotals,
  docItemsOf,
  groupBase,
  normalizeItems,
  saveDocItems,
  removeDocItems,
  type DocItem,
} from './documentService';

export const ENTRIES_KEY = 'contractoros_entries';
export const ENTRY_LINES_KEY = 'contractoros_entry_lines';
export const ACCOUNTS_KEY = 'contractoros_accounts';
export const BILL_LINKS_KEY = 'contractoros_bill_links';
export const BOOKS_META_KEY = 'contractoros_books_meta';

// ---------------------------------------------------------------------------
// Schema (S2.2)
// ---------------------------------------------------------------------------
export type EntryType =
  | 'supplier-bill'
  | 'payment-supplier'
  | 'client-receipt'
  | 'client-invoice'
  | 'client-advance'
  | 'opening-balance'
  | 'expense-paid'
  | 'worker-advance'
  | 'transfer'
  | 'owner-loan-in'
  | 'adjustment'
  | 'payroll-accrual'
  | 'payroll-payment'
  | 'reversal'
  | 'stock-receipt'
  | 'stock-issue'
  | 'stock-adjust'
  // Documents that give money back / reverse part of a bill
  | 'purchase-return'
  | 'credit-note'
  // inferred types used by the legacy migration (S1.2)
  | 'receipt'
  | 'payment'
  | 'journal';

export type EntrySource = 'manual' | 'payroll' | 'billing';

export type AccountKind =
  | 'cash' | 'bank' | 'asset' | 'receivable' | 'payable'
  | 'worker' | 'expense' | 'income' | 'liability' | 'equity';

export interface Account {
  id: string;
  name: string;
  kind: AccountKind;
}

export interface EditVersion {
  at: string;
  reason: string;
  entry: Entry; // previous version of the entry …
  lines: EntryLine[]; // … and its previous generated lines (S3.5)
}

export interface Entry {
  id: string; // voucher id, e.g. "SB-2083/84-001" (id IS the voucher, S2.2)
  type: EntryType;
  ad_date: string; // canonical "YYYY-MM-DD"
  bs_y: number; // local-calendar integers, computed once at write (S2.4)
  bs_m: number;
  bs_d: number;
  ref: string; // user reference (also holds origin ref: bill id / run id)
  note: string;
  attachment: string; // attachment path (S1.2 preserves legacy paths)
  source: EntrySource;
  created_at: string;
  edited_history: EditVersion[];
  /** Payment due date of the document, computed once at write time (S2.4). */
  due_date?: string;
  /** The entry this one exactly negates. A document is reversed at most once. */
  reversal_of?: string;
  /** Counterparty PAN printed on the document (Rule 17 requirement). */
  party_pan?: string;
  /** Counterparty address printed on the document. */
  party_address?: string;
  /** Measurement-book reference for a running bill (site measurement sheet). */
  mb_ref?: string;
  /**
   * Supplier bill settled when it was entered: the Payment to Supplier entry
   * posted with it. Absent on every other entry (additive, so old records load
   * exactly as before).
   */
  auto_payment_id?: string;
  /** The supplier bill that this auto-payment settles (the reverse of the link). */
  auto_bill_id?: string;
}

export interface EntryLine {
  id: string;
  entry_id: string;
  account_id: string;
  party_id: string;
  worker_id: string;
  project_id: string;
  cost_code: string;
  boq_code?: string;
  debit: number;
  credit: number;
  memo: string;
  bill_link_id: string;
}

export interface BillLink {
  payment_line_id: string;
  bill_line_id: string;
  applied_amount: number;
}

export interface BooksMeta {
  migrated_at: string | null;
  migrated_entry_ids: string[];
  locks: Record<string, { locked_at: string; reason: string }>;
  audit: { at: string; action: 'lock' | 'unlock' | 'edit' | 'backup' | 'migration'; reason: string; target?: string }[];
}

/** Draft line returned by recipe(); `applies_to` becomes a bill_link at save. */
export interface DraftLine {
  account_id: string;
  party_id?: string;
  worker_id?: string;
  project_id?: string;
  cost_code?: string;
  debit: number;
  credit: number;
  boq_code?: string; // BOQ item this cost is booked against (actuals write-back)
  memo?: string;
  applies_to?: string; // target bill entry id → bill_links row (S2.2)
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

// Every book store is project-scoped: entries, lines, accounts and bill
// allocations of one job can never be read from (or written into) another.
function readJSON<T>(key: string, fallback: T): T {
  return readScoped<T>(key, fallback);
}
function writeJSON(key: string, value: unknown) {
  // Strict: a failed write must abort (and roll back) an atomic save.
  writeScopedStrict(key, value);
}

function emitChange() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('contractoros:books-changed'));
  }
}

// ---------------------------------------------------------------------------
// Accounts (find-or-create; seeded chart keeps ids stable across sessions)
// ---------------------------------------------------------------------------
export const SEED_ACCOUNTS: Account[] = [
  { id: 'acc:cash', name: 'Cash', kind: 'cash' },
  { id: 'acc:bank', name: 'Bank', kind: 'bank' },
  { id: 'acc:ar', name: 'Accounts Receivable', kind: 'receivable' },
  { id: 'acc:retention-ar', name: 'Retention Receivable', kind: 'receivable' },
  { id: 'acc:ap', name: 'Accounts Payable', kind: 'payable' },
  { id: 'acc:wht', name: 'Withholding Payable', kind: 'liability' },
  { id: 'acc:inventory', name: 'Materials Inventory', kind: 'asset' },
  { id: 'acc:stock-adjust', name: 'Stock Adjustment', kind: 'expense' },
  { id: 'acc:round-off', name: 'Round-off', kind: 'expense' },
  { id: 'acc:vat-input', name: 'VAT Recoverable (Input)', kind: 'asset' },
  { id: 'acc:vat-output', name: 'VAT Payable (Output)', kind: 'liability' },
  { id: 'acc:tds-payable', name: 'TDS Payable', kind: 'liability' },
  { id: 'acc:advance-supplier', name: 'Advance to Supplier', kind: 'asset' },
  { id: 'acc:advance-client', name: 'Advance from Client', kind: 'liability' },
  { id: 'acc:capital', name: 'Owner Capital', kind: 'equity' },
  { id: 'acc:loan', name: 'Loan Payable', kind: 'liability' },
  { id: 'acc:income', name: 'Contract Income', kind: 'income' },
  { id: 'acc:opening', name: 'Opening Balance', kind: 'equity' },
  { id: 'acc:conversion', name: 'Legacy Conversion', kind: 'equity' },
];

export function slug(s: string): string {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function expenseAccountId(category: string): string {
  return `acc:exp:${slug(category) || 'misc'}`;
}
export function workerAccountId(workerId: string): string {
  return `acc:worker:${slug(workerId)}`;
}

export function loadAccounts(): Account[] {
  const stored = readJSON<Account[]>(ACCOUNTS_KEY, []);
  const byId = new Map<string, Account>();
  for (const a of [...SEED_ACCOUNTS, ...stored]) if (a && a.id) byId.set(a.id, a);
  return [...byId.values()];
}

/** Find-or-create an account; persisted so ids stay stable. */
export function ensureAccount(id: string, name: string, kind: AccountKind): Account {
  const accounts = loadAccounts();
  const existing = accounts.find((a) => a.id === id);
  if (existing) return existing;
  const acc: Account = { id, name, kind };
  const stored = readJSON<Account[]>(ACCOUNTS_KEY, []);
  stored.push(acc);
  writeJSON(ACCOUNTS_KEY, stored);
  return acc;
}

export function accountName(id: string): string {
  const a = loadAccounts().find((x) => x.id === id);
  if (a) return a.name;
  if (id.startsWith('acc:exp:')) return 'Expense';
  if (id.startsWith('acc:worker:')) return 'Worker';
  return id;
}

export function accountKind(id: string): AccountKind | null {
  return loadAccounts().find((x) => x.id === id)?.kind ?? null;
}

/** Account options for the Adjustment journal (S3.2). */
export function accountsForAdjustment(): Account[] {
  return loadAccounts().slice().sort((a, b) => a.name.localeCompare(b.name));
}

/** cash | bank account id for a legacy-style payment method (S1.2). */
export function cashAccountForMethod(method: string): string {
  const m = String(method || 'cash').toLowerCase();
  return m === 'bank' || m === 'cheque' ? 'acc:bank' : 'acc:cash';
}

// Labour expense categories are owned by payroll (S0.3): the hopper blocks
// them and shows a pointer to the Labour page instead. The list itself lives
// in masterData (single source of truth for cost codes).

export const EXPENSE_CATEGORIES = LEDGER_CATEGORIES.filter((c) => !isLabourCategory(c));

// ---------------------------------------------------------------------------
// THE posting engine (S2.3): pure recipe(type, form) → lines[]
// Both the live routing preview and save call this — preview == truth.
// ---------------------------------------------------------------------------
function line(d: DraftLine): DraftLine {
  return { ...d, debit: round2(d.debit || 0), credit: round2(d.credit || 0) };
}
function requireAmount(n: number, what = 'Amount'): number {
  const v = round2(n);
  if (!(v > 0)) throw new Error(`${what} must be greater than zero.`);
  return v;
}

export function recipe(type: EntryType, form: any): DraftLine[] {
  switch (type) {
    case 'supplier-bill': {
      if (!form.supplier) throw new Error('Supplier is required.');
      // ---- multi-item bill (the ordinary case for a contractor) -----------
      const items = normalizeItems(form.items, {
        cost_code: form.cost_code || '',
        project_id: form.project || '',
        boq_code: form.boq_code || '',
      });
      if (items.length > 0) {
        for (const it of items) {
          if (!it.description) throw new Error(`Line ${it.line_no} needs a description.`);
          const cat = it.cost_code || form.cost_code || 'Others';
          if (isLabourCategory(cat)) throw new Error(`Line ${it.line_no}: labour is owned by payroll — use the Labour page.`);
        }
        const totals = documentTotals(items, {
          vatRate: Number(form.vat_rate) || 0,
          vatIncluded: Boolean(form.vat_included),
          tdsRate: Number(form.tds_rate) || 0,
          discount: Number(form.discount) || 0,
          roundOff: Number(form.round_off) || 0,
        });
        if (!(totals.base > 0)) throw new Error('Bill amount must be greater than zero.');
        const out: DraftLine[] = [];
        for (const g of groupBase(items, totals.lines)) {
          const cat = g.cost_code || form.cost_code || 'Others';
          ensureAccount(expenseAccountId(cat), cat, 'expense');
          out.push(
            line({
              account_id: expenseAccountId(cat),
              project_id: g.project_id || form.project || '',
              cost_code: cat,
              boq_code: g.boq_code || undefined,
              debit: g.amount,
              credit: 0,
              memo: `Accrued: ${cat} (${items.length} item${items.length > 1 ? 's' : ''})`,
            })
          );
        }
        if (totals.vat > 0) {
          out.push(line({ account_id: 'acc:vat-input', party_id: String(form.supplier), debit: totals.vat, credit: 0, memo: 'VAT recoverable' }));
        }
        const due = Number(form.due_days) || 0;
        if (totals.payable > 0) {
          out.push(line({ account_id: 'acc:ap', party_id: String(form.supplier), debit: 0, credit: totals.payable, memo: due ? `Due in ${due} days` : 'Accrued payable' }));
        }
        if (totals.tds > 0) {
          out.push(line({ account_id: 'acc:tds-payable', party_id: String(form.supplier), debit: 0, credit: totals.tds, memo: `TDS ${Number(form.tds_rate) || 0}% withheld` }));
        }
        // Cash rounding: a bill rounded up is a tiny cost, rounded down a tiny
        // gain — recorded on its own line, never buried in an expense code.
        if (totals.roundOff !== 0) {
          out.push(
            line({
              account_id: 'acc:round-off',
              debit: totals.roundOff > 0 ? totals.roundOff : 0,
              credit: totals.roundOff < 0 ? -totals.roundOff : 0,
              memo: 'Bill round-off',
            })
          );
        }
        return out;
      }
      const computed = round2((Number(form.qty) || 0) * (Number(form.rate) || 0));
      const gross = requireAmount(computed || Number(form.amount), 'Bill amount');
      if (!form.supplier) throw new Error('Supplier is required.');
      const category = form.cost_code || form.category || 'Others';
      if (isLabourCategory(category)) throw new Error('Labour lines are owned by payroll — use the Labour page.');
      const due = Number(form.due_days) || 0;
      ensureAccount(expenseAccountId(category), category, 'expense');
      // VAT/TDS are opt-in per document (rate 0 = no tax line), so imported and
      // pre-tax postings keep routing exactly as they did before.
      const tax = taxBreakdown({
        gross,
        vatRate: Number(form.vat_rate) || 0,
        vatIncluded: Boolean(form.vat_included),
        tdsRate: Number(form.tds_rate) || 0,
      });
      const out: DraftLine[] = [
        line({ account_id: expenseAccountId(category), project_id: form.project || '', cost_code: category, boq_code: form.boq_code || undefined, debit: tax.base, credit: 0, memo: `Accrued: ${category}` }),
      ];
      if (tax.vat > 0) {
        out.push(line({ account_id: 'acc:vat-input', party_id: String(form.supplier), debit: tax.vat, credit: 0, memo: `VAT ${Number(form.vat_rate) || 0}% recoverable` }));
      }
      if (tax.net > 0) {
        out.push(line({ account_id: 'acc:ap', party_id: String(form.supplier), debit: 0, credit: tax.net, memo: due ? `Due in ${due} days` : 'Accrued payable' }));
      }
      if (tax.tds > 0) {
        out.push(line({ account_id: 'acc:tds-payable', party_id: String(form.supplier), debit: 0, credit: tax.tds, memo: `TDS ${Number(form.tds_rate) || 0}% withheld` }));
      }
      return out;
    }
    case 'payment-supplier': {
      if (!form.supplier) throw new Error('Supplier is required.');
      const amount = requireAmount(Number(form.amount));
      const withholding = round2(Number(form.withholding) || 0);
      if (withholding < 0 || withholding >= amount) throw new Error('Withholding must be between 0 and the amount.');
      const allocations: { capture_id?: string; entry_id?: string; applied: number }[] = form.allocations || [];
      const applied = round2(allocations.reduce((s, a) => s + (Number(a.applied) || 0), 0));
      const over = round2(amount - withholding - applied);
      if (over < 0) throw new Error('Allocated amount exceeds the payment.');
      const out: DraftLine[] = allocations
        .filter((a) => Number(a.applied) > 0)
        .map((a) => line({ account_id: 'acc:ap', party_id: String(form.supplier), debit: round2(a.applied), credit: 0, memo: 'Settles open bill', applies_to: a.entry_id || a.capture_id }));
      if (over > 0) out.push(line({ account_id: 'acc:advance-supplier', party_id: String(form.supplier), debit: over, credit: 0, memo: 'Overpayment → advance (flagged)' }));
      if (withholding > 0) out.push(line({ account_id: 'acc:wht', party_id: String(form.supplier), debit: withholding, credit: 0, memo: 'Withholding held' }));
      out.push(line({ account_id: cashAccountForMethod(form.method), debit: 0, credit: amount, memo: 'Cash/Bank out' }));
      return out;
    }
    case 'client-receipt': {
      if (!form.client) throw new Error('Client is required.');
      const amount = requireAmount(Number(form.amount));
      const retention = round2(Number(form.retention_release) || 0);
      if (retention < 0 || retention > amount) throw new Error('Retention release must be within the amount.');
      const allocations: { capture_id?: string; entry_id?: string; applied: number }[] = form.allocations || [];
      const applied = round2(allocations.reduce((s, a) => s + (Number(a.applied) || 0), 0));
      const toAr = round2(amount - retention);
      if (applied > toAr) throw new Error('Allocated amount exceeds receivable part.');
      const out: DraftLine[] = [
        line({ account_id: cashAccountForMethod(form.method), debit: amount, credit: 0, memo: 'Cash/Bank in' }),
      ];
      if (applied > 0) {
        for (const a of allocations) {
          if (Number(a.applied) > 0) out.push(line({ account_id: 'acc:ar', party_id: String(form.client), debit: 0, credit: round2(a.applied), memo: 'Applies invoice', applies_to: a.entry_id || a.capture_id }));
        }
      }
      const unapplied = round2(toAr - applied);
      if (unapplied > 0) out.push(line({ account_id: 'acc:ar', party_id: String(form.client), debit: 0, credit: unapplied, memo: applied > 0 ? 'On account (rest)' : 'On account' }));
      if (retention > 0) out.push(line({ account_id: 'acc:retention-ar', party_id: String(form.client), debit: 0, credit: retention, memo: 'Retention released' }));
      return out;
    }
    case 'client-invoice': {
      if (!form.client) throw new Error('Client is required.');
      // ---- multi-line running bill (BOQ items on one invoice) -------------
      const invoiceItems = normalizeItems(form.items, { project_id: form.project || '' });
      if (invoiceItems.length > 0) {
        const totals = documentTotals(invoiceItems, {
          vatRate: Number(form.vat_rate) || 0,
          vatIncluded: Boolean(form.vat_included),
          retentionPct: Math.min(100, Math.max(0, Number(form.retention_pct) || 0)),
          discount: Number(form.discount) || 0,
          roundOff: Number(form.round_off) || 0,
        });
        if (!(totals.base > 0)) throw new Error('Invoice amount must be greater than zero.');
        const project = form.project || '';
        const client = String(form.client);
        // Advance recovery: only what the client has actually advanced can be
        // recovered on this bill.
        const advanceHeld = clientAdvanceBalance(client);
        const advance = round2(Number(form.advance_recovery) || 0);
        if (advance < 0) throw new Error('Advance recovery cannot be negative.');
        if (advance > advanceHeld + 0.005) {
          throw new Error(`Only ${advanceHeld} of client advance is outstanding — cannot recover ${advance}.`);
        }
        // payable already excludes retention and carries the round-off
        const receivable = round2(totals.payable - advance);
        if (receivable < 0) throw new Error('Advance recovery exceeds this bill.');
        const out: DraftLine[] = [];
        if (receivable > 0) {
          out.push(line({ account_id: 'acc:ar', party_id: String(form.client), project_id: project, debit: receivable, credit: 0, memo: 'Receivable' }));
        }
        if (totals.retention > 0) {
          out.push(line({ account_id: 'acc:retention-ar', party_id: String(form.client), project_id: project, debit: totals.retention, credit: 0, memo: `Retention ${Number(form.retention_pct) || 0}%` }));
        }
        if (totals.vat > 0) {
          out.push(line({ account_id: 'acc:vat-output', party_id: String(form.client), project_id: project, debit: 0, credit: totals.vat, memo: 'VAT payable' }));
        }
        // Income is recognised per job: one bill can never hide which job earned it.
        const byProject = new Map<string, number>();
        invoiceItems.forEach((it, i) => {
          const pid = it.project_id || project;
          byProject.set(pid, round2((byProject.get(pid) || 0) + (totals.lines[i]?.base || 0)));
        });
        for (const [pid, amount] of byProject) {
          if (amount > 0) out.push(line({ account_id: 'acc:income', project_id: pid, debit: 0, credit: amount, memo: 'Contract income' }));
        }
        if (totals.roundOff !== 0) {
          out.push(
            line({
              account_id: 'acc:round-off',
              debit: totals.roundOff < 0 ? -totals.roundOff : 0,
              credit: totals.roundOff > 0 ? totals.roundOff : 0,
              memo: 'Invoice round-off',
            })
          );
        }
        if (advance > 0) {
          out.push(line({ account_id: 'acc:advance-client', party_id: client, project_id: project, debit: advance, credit: 0, memo: 'Advance recovered on this bill' }));
        }
        return out;
      }
      const amount = requireAmount(Number(form.amount), 'Invoice amount');
      const tax = taxBreakdown({
        gross: amount,
        vatRate: Number(form.vat_rate) || 0,
        vatIncluded: Boolean(form.vat_included),
      });
      const pct = Math.min(100, Math.max(0, Number(form.retention_pct) || 0));
      // Retention is withheld from the taxable value, never from the VAT.
      const retention = round2((tax.base * pct) / 100);
      const receivable = round2(tax.total - retention);
      const out: DraftLine[] = [];
      if (receivable > 0) out.push(line({ account_id: 'acc:ar', party_id: String(form.client), project_id: form.project || '', debit: receivable, credit: 0, memo: 'Receivable' }));
      if (retention > 0) out.push(line({ account_id: 'acc:retention-ar', party_id: String(form.client), project_id: form.project || '', debit: retention, credit: 0, memo: `Retention ${pct}%` }));
      if (tax.vat > 0) out.push(line({ account_id: 'acc:vat-output', party_id: String(form.client), project_id: form.project || '', debit: 0, credit: tax.vat, memo: `VAT ${Number(form.vat_rate) || 0}% payable` }));
      out.push(line({ account_id: 'acc:income', project_id: form.project || '', debit: 0, credit: tax.base, memo: 'Contract income' }));
      return out;
    }
    case 'opening-balance': {
      // Opening figures: the only way to start books that already have money in
      // the bank or parties owing. Every opening is offset against Opening
      // Balance (equity), so the trial balance stays honest.
      const amount = requireAmount(Number(form.amount), 'Opening amount');
      const target = String(form.account || 'cash');
      if (target === 'cash' || target === 'bank') {
        const acc = target === 'bank' ? 'acc:bank' : 'acc:cash';
        return [
          line({ account_id: acc, debit: amount, credit: 0, memo: 'Opening balance' }),
          line({ account_id: 'acc:opening', debit: 0, credit: amount, memo: 'Opening balance' }),
        ];
      }
      if (!form.party) throw new Error('An opening receivable/payable needs the party.');
      if (target === 'receivable') {
        return [
          line({ account_id: 'acc:ar', party_id: String(form.party), project_id: form.project || '', debit: amount, credit: 0, memo: 'Opening receivable' }),
          line({ account_id: 'acc:opening', debit: 0, credit: amount, memo: 'Opening balance' }),
        ];
      }
      return [
        line({ account_id: 'acc:opening', debit: amount, credit: 0, memo: 'Opening balance' }),
        line({ account_id: 'acc:ap', party_id: String(form.party), project_id: form.project || '', debit: 0, credit: amount, memo: 'Opening payable' }),
      ];
    }
    case 'client-advance': {
      // Mobilisation / advance money received before an invoice exists: it is a
      // liability until the running bill recovers it.
      if (!form.client) throw new Error('Client is required.');
      const amount = requireAmount(Number(form.amount), 'Advance amount');
      return [
        line({ account_id: cashAccountForMethod(form.method), party_id: String(form.client), debit: amount, credit: 0, memo: 'Advance received' }),
        line({ account_id: 'acc:advance-client', party_id: String(form.client), project_id: form.project || '', debit: 0, credit: amount, memo: 'Client advance held' }),
      ];
    }
    case 'expense-paid': {
      const category = form.category;
      if (!category) throw new Error('Category is required.');
      if (isLabourCategory(category)) {
        throw new Error('Labour expense is owned by payroll — open the Labour page instead.');
      }
      const amount = requireAmount(Number(form.amount));
      ensureAccount(expenseAccountId(category), category, 'expense');
      return [
        line({ account_id: expenseAccountId(category), project_id: form.project || 'overhead', cost_code: category, boq_code: form.boq_code || undefined, debit: amount, credit: 0, memo: form.ref || category }),
        line({ account_id: cashAccountForMethod(form.method), project_id: form.project || 'overhead', debit: 0, credit: amount, memo: 'Cash/Bank out' }),
      ];
    }
    case 'worker-advance': {
      if (!form.worker_id) throw new Error('Worker is required.');
      const amount = requireAmount(Number(form.amount), 'Advance amount');
      ensureAccount(workerAccountId(form.worker_id), form.worker_name || form.worker_id, 'worker');
      return [
        line({ account_id: workerAccountId(form.worker_id), worker_id: String(form.worker_id), debit: amount, credit: 0, memo: 'Worker advance' }),
        line({ account_id: cashAccountForMethod(form.method), debit: 0, credit: amount, memo: 'Cash/Bank out' }),
      ];
    }
    case 'transfer': {
      const amount = requireAmount(Number(form.amount));
      const from = form.from === 'bank' ? 'acc:bank' : 'acc:cash';
      const to = form.to === 'cash' ? 'acc:cash' : 'acc:bank';
      if (from === to) throw new Error('Transfer needs two different accounts.');
      return [
        line({ account_id: to, debit: amount, credit: 0, memo: 'Transfer in' }),
        line({ account_id: from, debit: 0, credit: amount, memo: 'Transfer out' }),
      ];
    }
    case 'owner-loan-in': {
      const amount = requireAmount(Number(form.amount));
      const creditAcc = form.source === 'loan' ? 'acc:loan' : 'acc:capital';
      return [
        line({ account_id: cashAccountForMethod(form.method), debit: amount, credit: 0, memo: 'Cash/Bank in' }),
        line({ account_id: creditAcc, debit: 0, credit: amount, memo: form.source === 'loan' ? 'Loan received' : 'Owner capital in' }),
      ];
    }
    case 'adjustment': {
      const amount = requireAmount(Number(form.amount));
      if (!form.debit_account || !form.credit_account) throw new Error('Both accounts are required.');
      if (form.debit_account === form.credit_account) throw new Error('Debit and credit accounts must differ.');
      return [
        line({ account_id: form.debit_account, debit: amount, credit: 0, memo: form.note || 'Adjustment' }),
        line({ account_id: form.credit_account, debit: 0, credit: amount, memo: form.note || 'Adjustment' }),
      ];
    }
    case 'payroll-accrual': {
      // Dr labour expense per project split · Cr worker balances (S5.1)
      const workers: { worker_id: string; name?: string; amount: number }[] = form.workers || [];
      const splits: { project_id: string; amount: number; boq_code?: string }[] = form.project_splits || [];
      const totalW = round2(workers.reduce((s, w) => s + (Number(w.amount) || 0), 0));
      const totalP = round2(splits.reduce((s, p) => s + (Number(p.amount) || 0), 0));
      if (!(totalW > 0)) throw new Error('Payroll total must be positive.');
      if (Math.abs(totalW - totalP) > 0.005) throw new Error('Project splits must equal worker totals.');
      ensureAccount(expenseAccountId('Labour'), 'Labour', 'expense');
      const out: DraftLine[] = splits
        .filter((p) => Number(p.amount) > 0)
        .map((p) => line({ account_id: expenseAccountId('Labour'), project_id: p.project_id, cost_code: 'Labour', boq_code: p.boq_code || undefined, debit: round2(p.amount), credit: 0, memo: 'Labour accrual' }));
      for (const w of workers) {
        if (!(Number(w.amount) > 0)) continue;
        ensureAccount(workerAccountId(w.worker_id), w.name || w.worker_id, 'worker');
        out.push(line({ account_id: workerAccountId(w.worker_id), worker_id: String(w.worker_id), debit: 0, credit: round2(w.amount), memo: 'Accrued net pay' }));
      }
      return out;
    }
    case 'payroll-payment': {
      // Dr worker balances · Cr bank/cash per method (S5.1)
      const workers: { worker_id: string; name?: string; amount: number; method?: string }[] = form.workers || [];
      if (!workers.some((w) => Number(w.amount) > 0)) throw new Error('Payment total must be positive.');
      const out: DraftLine[] = [];
      for (const w of workers) {
        if (!(Number(w.amount) > 0)) continue;
        ensureAccount(workerAccountId(w.worker_id), w.name || w.worker_id, 'worker');
        out.push(line({ account_id: workerAccountId(w.worker_id), worker_id: String(w.worker_id), debit: round2(w.amount), credit: 0, memo: 'Payroll settled' }));
      }
      const byAcc: Record<string, number> = {};
      for (const w of workers) {
        if (!(Number(w.amount) > 0)) continue;
        const acc = cashAccountForMethod(w.method || 'cash');
        byAcc[acc] = round2((byAcc[acc] || 0) + Number(w.amount));
      }
      for (const [acc, amt] of Object.entries(byAcc)) {
        out.push(line({ account_id: acc, debit: 0, credit: amt, memo: 'Payroll paid' }));
      }
      return out;
    }
    case 'receipt':
    case 'payment':
    case 'journal': {
      // Inferred migration shapes (S1.2) — also usable directly.
      const amount = requireAmount(Number(form.amount));
      const acc = form.account_id || 'acc:cash';
      if (type === 'receipt') {
        return [
          line({ account_id: acc, debit: amount, credit: 0, memo: form.memo || 'Receipt' }),
          line({ account_id: form.counter_account_id || 'acc:conversion', debit: 0, credit: amount, memo: form.memo || 'Receipt' }),
        ];
      }
      if (type === 'payment') {
        return [
          line({ account_id: form.counter_account_id || 'acc:conversion', debit: amount, credit: 0, memo: form.memo || 'Payment' }),
          line({ account_id: acc, debit: 0, credit: amount, memo: form.memo || 'Payment' }),
        ];
      }
      return [
        line({ account_id: form.debit_account_id || 'acc:conversion', debit: amount, credit: 0, memo: form.memo || 'Journal' }),
        line({ account_id: form.credit_account_id || 'acc:conversion', debit: 0, credit: amount, memo: form.memo || 'Journal' }),
      ];
    }
    // ---- Material inventory (stockService posts these) --------------------
    case 'stock-receipt': {
      // Goods into the store. Cost stays an asset until it is issued to a job.
      const qty = requireAmount(Number(form.qty), 'Quantity');
      const rate = round2(Number(form.rate));
      if (!(rate > 0)) throw new Error('A receipt needs the unit cost paid.');
      if (!form.item_name) throw new Error('An item is required.');
      const tax = taxBreakdown({
        gross: round2(qty * rate),
        vatRate: Number(form.vat_rate) || 0,
        vatIncluded: Boolean(form.vat_included),
      });
      // The asset always carries the tax-exclusive cost: recoverable VAT is not
      // part of what the material cost the job.
      const out: DraftLine[] = [
        line({ account_id: 'acc:inventory', debit: tax.base, credit: 0, memo: `Stock in: ${form.item_name}` }),
      ];
      if (tax.vat > 0) {
        out.push(line({ account_id: 'acc:vat-input', party_id: String(form.supplier || ''), debit: tax.vat, credit: 0, memo: `VAT ${Number(form.vat_rate) || 0}% on stock` }));
      }
      if (form.source === 'supplier') {
        if (!form.supplier) throw new Error('A credit purchase needs the supplier.');
        const due = Number(form.due_days) || 0;
        out.push(line({ account_id: 'acc:ap', party_id: String(form.supplier), debit: 0, credit: tax.total, memo: due ? `Due in ${due} days` : 'Stock purchased on credit' }));
      } else {
        out.push(line({ account_id: cashAccountForMethod(form.method), debit: 0, credit: tax.total, memo: 'Stock paid' }));
      }
      return out;
    }
    case 'stock-issue': {
      // Materials leave the store and become that job's cost, at the moving
      // average the store carried them at — never at a re-typed price.
      const qty = requireAmount(Number(form.qty), 'Quantity');
      const rate = round2(Number(form.rate));
      if (!(rate > 0)) throw new Error('An issue needs the stock unit cost.');
      if (!form.item_name) throw new Error('An item is required.');
      const project = String(form.project || '').trim();
      if (!project) throw new Error('An issue must name the job it was consumed on.');
      const category = String(form.cost_code || 'Materials');
      const amount = round2(qty * rate);
      ensureAccount(expenseAccountId(category), category, 'expense');
      return [
        line({ account_id: expenseAccountId(category), project_id: project, cost_code: category, boq_code: form.boq_code || undefined, debit: amount, credit: 0, memo: `Issued: ${form.item_name} × ${qty}` }),
        line({ account_id: 'acc:inventory', debit: 0, credit: amount, memo: `Stock out: ${form.item_name}` }),
      ];
    }
    case 'stock-adjust': {
      // Physical count vs book: a gain or a write-off, at the carrying cost.
      const diff = round2(Number(form.qty_diff));
      if (!diff) throw new Error('A stock adjustment needs a non-zero quantity difference.');
      const rate = round2(Number(form.rate));
      if (!(rate > 0)) throw new Error('A stock adjustment needs the carrying unit cost.');
      const amount = round2(Math.abs(diff) * rate);
      const gain = diff > 0;
      return [
        line({ account_id: 'acc:inventory', debit: gain ? amount : 0, credit: gain ? 0 : amount, memo: `Count ${gain ? 'gain' : 'loss'}: ${form.item_name}` }),
        line({ account_id: 'acc:stock-adjust', debit: gain ? 0 : amount, credit: gain ? amount : 0, memo: `Count ${gain ? 'gain' : 'loss'}: ${form.item_name}` }),
      ];
    }
    case 'purchase-return': {
      // Debit note to a supplier: part of a bill goes back (wrong item, short
      // delivery, damaged goods). It reduces the payable and takes the VAT with
      // it — never a negative bill, so history stays readable.
      if (!form.supplier) throw new Error('Supplier is required.');
      const items = normalizeItems(form.items, {
        cost_code: form.cost_code || '',
        project_id: form.project || '',
        boq_code: form.boq_code || '',
      });
      if (items.length === 0) throw new Error('A purchase return needs at least one item.');
      for (const it of items) {
        if (!it.description) throw new Error(`Line ${it.line_no} needs a description.`);
        const cat = it.cost_code || form.cost_code || 'Others';
        if (isLabourCategory(cat)) throw new Error(`Line ${it.line_no}: labour is owned by payroll.`);
      }
      const totals = documentTotals(items, { vatRate: Number(form.vat_rate) || 0, vatIncluded: Boolean(form.vat_included) });
      if (!(totals.base > 0)) throw new Error('Return amount must be greater than zero.');
      const out: DraftLine[] = [
        line({ account_id: 'acc:ap', party_id: String(form.supplier), debit: totals.total, credit: 0, memo: 'Return against supplier' }),
      ];
      for (const g of groupBase(items, totals.lines)) {
        const cat = g.cost_code || form.cost_code || 'Others';
        ensureAccount(expenseAccountId(cat), cat, 'expense');
        out.push(
          line({
            account_id: expenseAccountId(cat),
            project_id: g.project_id || form.project || '',
            cost_code: cat,
            boq_code: g.boq_code || undefined,
            debit: 0,
            credit: g.amount,
            memo: `Return: ${cat}`,
          })
        );
      }
      if (totals.vat > 0) {
        out.push(line({ account_id: 'acc:vat-input', party_id: String(form.supplier), debit: 0, credit: totals.vat, memo: 'VAT reversed on return' }));
      }
      return out;
    }
    case 'credit-note': {
      // Credit note to a client: work billed before is reduced or corrected.
      if (!form.client) throw new Error('Client is required.');
      const items = normalizeItems(form.items, { project_id: form.project || '' });
      if (items.length === 0) throw new Error('A credit note needs at least one line.');
      const totals = documentTotals(items, { vatRate: Number(form.vat_rate) || 0, vatIncluded: Boolean(form.vat_included) });
      if (!(totals.base > 0)) throw new Error('Credit note amount must be greater than zero.');
      const project = form.project || '';
      const out: DraftLine[] = [];
      const byProject = new Map<string, number>();
      items.forEach((it, i) => {
        const pid = it.project_id || project;
        byProject.set(pid, round2((byProject.get(pid) || 0) + (totals.lines[i]?.base || 0)));
      });
      for (const [pid, amount] of byProject) {
        if (amount > 0) out.push(line({ account_id: 'acc:income', project_id: pid, debit: amount, credit: 0, memo: 'Credit note' }));
      }
      if (totals.vat > 0) {
        out.push(line({ account_id: 'acc:vat-output', party_id: String(form.client), project_id: project, debit: totals.vat, credit: 0, memo: 'VAT reversed on credit note' }));
      }
      out.push(line({ account_id: 'acc:ar', party_id: String(form.client), project_id: project, debit: 0, credit: totals.total, memo: 'Credit note' }));
      return out;
    }
    case 'reversal': {
      // Mirror image of the reversed entry: every line swaps Dr and Cr at the
      // same dimensions, so the pair nets to zero without touching history.
      const srcId = String(form.reverses || '');
      const src = entryById(srcId);
      if (!src) throw new Error('A reversal must name the entry it reverses.');
      if (src.type === 'reversal') throw new Error('A reversal cannot itself be reversed.');
      if (isReversed(srcId)) throw new Error(`${srcId} is already reversed.`);
      const srcLines = linesOf(srcId);
      if (srcLines.length === 0) throw new Error(`${srcId} has no lines to reverse.`);
      return srcLines.map((l) =>
        line({
          account_id: l.account_id,
          party_id: l.party_id || undefined,
          worker_id: l.worker_id || undefined,
          project_id: l.project_id || undefined,
          cost_code: l.cost_code || undefined,
          boq_code: l.boq_code || undefined,
          debit: l.credit,
          credit: l.debit,
          memo: `Reversal of ${srcId}`,
        })
      );
    }
    default:
      throw new Error(`Unknown entry type: ${type}`);
  }
}

// ---------------------------------------------------------------------------
// Voucher series per type per fiscal year (S6.2) — extends the shared
// voucher numbering service (ledgerService) with the new series.
// ---------------------------------------------------------------------------
export const ENTRY_PREFIX: Record<EntryType, string> = {
  'supplier-bill': 'SB',
  'payment-supplier': 'PS',
  'client-receipt': 'CR',
  'client-invoice': 'CI',
  'client-advance': 'CA',
  'opening-balance': 'OB',
  'expense-paid': 'EX',
  'worker-advance': 'WA',
  transfer: 'TR',
  'owner-loan-in': 'OI',
  adjustment: 'AJ',
  'payroll-accrual': 'PA',
  'payroll-payment': 'PP',
  reversal: 'REV',
  'stock-receipt': 'SR',
  'stock-issue': 'SI',
  'stock-adjust': 'SA',
  'purchase-return': 'DN',
  'credit-note': 'CN',
  receipt: 'RV',
  payment: 'PV',
  journal: 'JV',
};

/**
 * Plain A.D. day arithmetic on the canonical "YYYY-MM-DD" string. B.S. values
 * are never computed here — a due date is a document fact, not a calendar one.
 */
export function addDays(adDate: string, days: number): string {
  const d = String(adDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return '';
  if (!Number.isFinite(Number(days)) || Number(days) <= 0) return '';
  return new Date(Date.parse(`${d}T00:00:00Z`) + Math.round(Number(days)) * 86400000).toISOString().slice(0, 10);
}

/** Due date of a document: explicit due_date, else issue date + due_days. */
export function resolveDueDate(adDate: string, form: any): string {
  const explicit = String(form?.due_date || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
  return addDays(adDate, Number(form?.due_days) || 0);
}

/** Next voucher for `type` in the fiscal year containing adDate. */
export function nextEntryVoucher(type: EntryType, adDate: string, entries?: Entry[]): string {
  const list = entries ?? allEntries();
  const bs = safeBs(adDate);
  const fy = fiscalYearOf(bs.year, bs.month);
  return nextInSeries(`${ENTRY_PREFIX[type]}-${fy.label}-`, list.map((e) => String(e.id || '')));
}

/** Kathmandu-anchored B.S. integers for a canonical AD date (S2.4). */
export function safeBs(adDate: string): { year: number; month: number; day: number } {
  try {
    const d = String(adDate).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { year: 0, month: 0, day: 0 };
    return adToBS(new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)), 12)));
  } catch {
    return { year: 0, month: 0, day: 0 };
  }
}

// ---------------------------------------------------------------------------
// Locks / audit (S6.1)
// ---------------------------------------------------------------------------
export function loadMeta(): BooksMeta {
  const m = readJSON<Partial<BooksMeta>>(BOOKS_META_KEY, {});
  return {
    migrated_at: m.migrated_at ?? null,
    migrated_entry_ids: m.migrated_entry_ids ?? [],
    locks: m.locks ?? {},
    audit: m.audit ?? [],
  };
}
export function saveMeta(meta: BooksMeta) {
  writeJSON(BOOKS_META_KEY, meta);
}
export function pushAudit(action: BooksMeta['audit'][number]['action'], reason: string, target?: string) {
  const meta = loadMeta();
  meta.audit = [...meta.audit, { at: new Date().toISOString(), action, reason, target }].slice(-500);
  saveMeta(meta);
}
export function getAudit(): BooksMeta['audit'] {
  return loadMeta().audit;
}
export function isPeriodLocked(y: number, m: number): boolean {
  return Boolean(loadMeta().locks[periodKey(y, m)]);
}
export function lockPeriod(y: number, m: number, reason: string) {
  if (!reason?.trim()) throw new Error('A reason is required to lock a period.');
  const meta = loadMeta();
  meta.locks[periodKey(y, m)] = { locked_at: new Date().toISOString(), reason: reason.trim() };
  saveMeta(meta);
  pushAudit('lock', reason.trim(), periodKey(y, m));
  emitChange();
}
export function unlockPeriod(y: number, m: number, reason: string) {
  if (!reason?.trim()) throw new Error('A reason is required to unlock a period.');
  const meta = loadMeta();
  delete meta.locks[periodKey(y, m)];
  saveMeta(meta);
  pushAudit('unlock', reason.trim(), periodKey(y, m));
  emitChange();
}
function assertNotLocked(bs: { year: number; month: number }, action: string) {
  const lock = loadMeta().locks[periodKey(bs.year, bs.month)];
  if (lock) {
    throw new Error(`Period ${periodKey(bs.year, bs.month)} is locked (${lock.reason}) — ${action} rejected. Unlock the period first with a reason.`);
  }
}

// ---------------------------------------------------------------------------
// Store: entries + lines + bill_links (atomic save / edit)
// ---------------------------------------------------------------------------
export function allEntries(): Entry[] {
  return readJSON<Entry[]>(ENTRIES_KEY, []);
}
export function allLines(): EntryLine[] {
  return readJSON<EntryLine[]>(ENTRY_LINES_KEY, []);
}
export function loadBillLinks(): BillLink[] {
  return readJSON<BillLink[]>(BILL_LINKS_KEY, []);
}
export function linesOf(entryId: string): EntryLine[] {
  return allLines().filter((l) => l.entry_id === entryId);
}
export function entryById(id: string): Entry | undefined {
  return allEntries().find((e) => e.id === id);
}
export function entriesForRef(ref: string): Entry[] {
  return allEntries().filter((e) => e.ref === ref || e.id === ref);
}

/** Client advance still held (credit balance of that client's advance account). */
export function clientAdvanceBalance(client: string): number {
  const name = String(client || '').trim();
  if (!name) return 0;
  return round2(
    allLines()
      .filter((l) => l.account_id === 'acc:advance-client' && l.party_id === name)
      .reduce((s, l) => s + l.credit - l.debit, 0)
  );
}

/**
 * Revenue billed on a job so far — the "previous bills" figure a running bill
 * deducts to arrive at this period's amount. A reversed invoice nets out.
 */
export function billedToDate(projectId: string, excludeEntryId?: string): number {
  const id = String(projectId || '').trim();
  if (!id) return 0;
  return round2(
    allLines()
      .filter((l) => l.account_id === 'acc:income' && l.project_id === id && l.entry_id !== excludeEntryId)
      .reduce((s, l) => s + l.credit - l.debit, 0)
  );
}

export interface SaveOpts {
  source?: EntrySource;
  attachment_path?: string;
  /** A picked document, stored and linked in the same atomic write. */
  attachment_file?: AttachmentInput;
  id?: string; // explicit id (migration keeps the legacy voucher)
}

/**
 * Atomic insert of entry + lines + bill_links (S3.4): the recipe is computed
 * first, then all three stores are written together; any failure rolls back.
 * Returns the saved entry. Throws on locked periods (S6.1).
 */
export function saveEntry(type: EntryType, form: any, opts: SaveOpts = {}): Entry {
  const adDate = String(form.date || form.ad_date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(adDate)) throw new Error('A valid A.D. date (YYYY-MM-DD) is required.');
  const bs = safeBs(adDate);
  if (bs.year === 0) throw new Error('Could not convert the date to the local calendar.');
  assertNotLocked(bs, 'saving an entry');
  const source: EntrySource = opts.source || 'manual';

  const drafts = recipe(type, form); // THE single posting path (S2.3)
  const totalDr = round2(drafts.reduce((s, l) => s + l.debit, 0));
  const totalCr = round2(drafts.reduce((s, l) => s + l.credit, 0));
  if (Math.abs(totalDr - totalCr) > 0.005) throw new Error(`Unbalanced entry: Dr ${totalDr} ≠ Cr ${totalCr}.`);

  // Adopt the party into the master and fill the printed identity from it: the
  // PAN typed once in Settings is the PAN on every later document.
  const partyName = String(form.supplier || form.client || '').trim();
  let partyPan = String(form.party_pan || '').trim();
  let partyAddress = String(form.party_address || '').trim();
  let creditDays = Number(form.due_days) || 0;
  if (partyName) {
    const party = ensureParty(partyName, form.supplier ? 'supplier' : 'client');
    if (party) {
      if (!partyPan) partyPan = party.pan;
      if (!partyAddress) partyAddress = party.address;
      if (!creditDays) creditDays = party.creditDays;
    }
  }

  // The document is validated and stored before anything is written, so an
  // invalid or oversized file aborts the whole save with nothing left behind.
  const storedDoc = opts.attachment_file ? storeDocument(opts.attachment_file) : null;

  // Register the job + cost code first so the roll-up never meets an unknown
  // dimension (existing data keeps posting — unknown values are adopted).
  for (const d of drafts) registerDimensions(d.project_id, d.cost_code);

  const prevEntries = allEntries();
  const prevLines = allLines();
  const prevLinks = loadBillLinks();

  const id = opts.id || uniqueId(nextEntryVoucher(type, adDate, prevEntries), prevEntries);
  const entry: Entry = {
    id,
    type,
    ad_date: adDate,
    bs_y: bs.year,
    bs_m: bs.month,
    bs_d: bs.day,
    ref: String(form.ref || ''),
    note: String(form.note || ''),
    attachment: storedDoc?.path || opts.attachment_path || String(form.attachment || ''),
    source,
    created_at: new Date().toISOString(),
    edited_history: [],
    due_date: resolveDueDate(adDate, { ...form, due_days: creditDays }) || undefined,
    reversal_of: type === 'reversal' ? String(form.reverses || '') || undefined : undefined,
    party_pan: partyPan || undefined,
    party_address: partyAddress || undefined,
    mb_ref: String(form.mb_ref || '').trim() || undefined,
  };

  const lines: EntryLine[] = drafts.map((d, i) => ({
    id: `${id}#${i + 1}`,
    entry_id: id,
    account_id: d.account_id,
    party_id: d.party_id || '',
    worker_id: d.worker_id || '',
    project_id: d.project_id || '',
    cost_code: d.cost_code || '',
    boq_code: d.boq_code || '',
    debit: d.debit,
    credit: d.credit,
    memo: d.memo || '',
    bill_link_id: '',
  }));
  const links: BillLink[] = [];
  drafts.forEach((d, i) => {
    if (d.applies_to && (d.debit > 0 || d.credit > 0)) {
      const link: BillLink = {
        payment_line_id: lines[i].id,
        // Point at the bill's own payable/receivable line: a multi-item bill has
        // several lines, so "#1" is no longer the control account.
        bill_line_id: controlLineOf(d.applies_to, prevLines, d),
        applied_amount: d.debit || d.credit,
      };
      links.push(link);
      lines[i].bill_link_id = `${link.payment_line_id}->${link.bill_line_id}`;
    }
  });

  try {
    writeJSON(ENTRIES_KEY, [...prevEntries, entry]);
    writeJSON(ENTRY_LINES_KEY, [...prevLines, ...lines]);
    if (links.length) writeJSON(BILL_LINKS_KEY, [...prevLinks, ...links]);
    // Item detail is part of the same atomic write: a document never exists
    // without the lines it was entered from.
    if (form.items) saveDocItems(id, normalizeItems(form.items));
    // Entry ↔ document link, in the same transaction as the entry.
    if (storedDoc) linkDocument(id, storedDoc.path);
  } catch (err) {
    try {
      writeJSON(ENTRIES_KEY, prevEntries); // roll back (atomic)
      writeJSON(ENTRY_LINES_KEY, prevLines);
      writeJSON(BILL_LINKS_KEY, prevLinks);
      removeDocItems(id);
    } finally {
      // No orphaned file — even if the storage that failed the save also
      // refuses the rollback, the document is still taken back.
      if (storedDoc) removeDocument(storedDoc.path);
    }
    throw err;
  }
  emitChange();
  syncBoqActuals();
  return entry;
}

/**
 * The line a settlement points at: a payment settles the bill's payable line, a
 * receipt settles the invoice's receivable line. Falls back to the document's
 * first line so legacy links keep their old behaviour.
 */
function controlLineOf(targetEntryId: string, lines: EntryLine[], draft: DraftLine): string {
  const target = lines.filter((l) => l.entry_id === targetEntryId);
  const account = draft.account_id === 'acc:ap' ? 'acc:ap' : 'acc:ar';
  const found = target.find((l) => l.account_id === account) || target[0];
  return found?.id || `${targetEntryId}#1`;
}

function uniqueId(id: string, entries: Entry[]): string {
  let out = id;
  let n = 1;
  while (entries.some((e) => e.id === out)) out = `${id}#${++n}`;
  return out;
}

// ---------------------------------------------------------------------------
// “Paid now” — a supplier bill settled in the same action.
//
// The bill and its payment stay TWO entries with their own lines and their own
// vouchers; only the action that writes them is shared. Both legs are built by
// the ordinary recipes above, so the books see exactly what the two-step flow
// produces (same accounts, VAT, discount spread, round-off, allocation).
// ---------------------------------------------------------------------------

/** What a supplier bill still owes: post-VAT, post-discount, including round-off. */
export function supplierBillPayable(drafts: DraftLine[]): number {
  return round2(drafts.reduce((s, l) => s + (l.account_id === 'acc:ap' ? l.credit - l.debit : 0), 0));
}

/**
 * The Payment to Supplier form that settles `amount` of `billId` in full, on
 * the bill's own date and reference. Withholding is always zero: TDS bills are
 * settled from the standalone payment form.
 */
export function supplierBillPaymentForm(form: any, amount: number, billId = ''): Record<string, unknown> {
  const payable = round2(amount);
  return {
    date: String(form?.pay_date || form?.date || '').slice(0, 10),
    supplier: String(form?.supplier || ''),
    amount: payable,
    method: form?.pay_method === 'bank' ? 'bank' : 'cash',
    withholding: 0,
    ref: String(form?.ref || ''),
    note: 'Paid in full with this bill',
    allocations: payable > 0 ? [{ entry_id: billId, applied: payable }] : [],
  };
}

export interface SavedBillPair {
  bill: Entry;
  /** Null when the bill was saved on credit (the ordinary flow). */
  payment: Entry | null;
}

/**
 * Save a supplier bill. With “Paid now” ticked it also posts the supplier
 * payment and links the pair both ways — one atomic action: the recipes for
 * both legs are validated first, and any failure restores the books exactly as
 * they were (no orphan bill, no orphan payment).
 *
 * Unticked → exactly saveEntry('supplier-bill', …).
 */
export function saveSupplierBill(form: any, opts: SaveOpts = {}): SavedBillPair {
  if (!form?.paid_now) return { bill: saveEntry('supplier-bill', form, opts), payment: null };

  if (Number(form.tds_rate) > 0) {
    throw new Error('TDS is withheld on payment — save this bill, then settle it from Payment to Supplier.');
  }

  // Validate BOTH legs before anything is written.
  const billDrafts = recipe('supplier-bill', form);
  const payable = supplierBillPayable(billDrafts);
  if (!(payable > 0)) throw new Error('This bill has nothing to pay — turn off “Paid now”.');
  recipe('payment-supplier', supplierBillPaymentForm(form, payable, 'pending'));

  const prevEntries = allEntries();
  const prevLines = allLines();
  const prevLinks = loadBillLinks();

  let billId = '';
  try {
    const bill = saveEntry('supplier-bill', form, opts);
    billId = bill.id;
    const payment = saveEntry('payment-supplier', supplierBillPaymentForm(form, payable, bill.id));
    // Both directions of the link are written with the pair, so either entry
    // can answer “what is this paired with?”.
    const linked = allEntries().map((e) =>
      e.id === bill.id ? { ...e, auto_payment_id: payment.id } : e.id === payment.id ? { ...e, auto_bill_id: bill.id } : e
    );
    writeJSON(ENTRIES_KEY, linked);
    emitChange();
    return {
      bill: linked.find((e) => e.id === bill.id)!,
      payment: linked.find((e) => e.id === payment.id)!,
    };
  } catch (err) {
    try {
      writeJSON(ENTRIES_KEY, prevEntries);
      writeJSON(ENTRY_LINES_KEY, prevLines);
      writeJSON(BILL_LINKS_KEY, prevLinks);
      if (billId) removeDocItems(billId);
    } finally {
      // The bill leg may already have stored its document; take it back with
      // the rolled-back bill so a failed pair leaves no orphan file.
      if (billId) for (const doc of documentsForEntry({ id: billId })) removeDocument(doc.path);
    }
    emitChange();
    throw err;
  }
}

/**
 * Attach a document to an entry posted by another service (a worker advance is
 * written by the labour recorder). The file and the link are written together;
 * if the link cannot be stored, the file and the entry go back as they were.
 */
export function attachDocumentToEntry(entryId: string, file: AttachmentInput): Entry {
  const entries = allEntries();
  const idx = entries.findIndex((e) => e.id === entryId);
  if (idx < 0) throw new Error(`Entry ${entryId} not found.`);
  const current = entries[idx];
  assertNotLocked({ year: current.bs_y, month: current.bs_m }, 'attaching a document');
  const stored = storeDocument(file);
  const next: Entry = { ...current, attachment: stored.path };
  const nextEntries = [...entries];
  nextEntries[idx] = next;
  try {
    writeJSON(ENTRIES_KEY, nextEntries);
    linkDocument(entryId, stored.path);
  } catch (err) {
    try {
      writeJSON(ENTRIES_KEY, entries);
    } finally {
      removeDocument(stored.path);
    }
    throw err;
  }
  emitChange();
  return next;
}

export function isEditable(entry: Entry): boolean {
  return entry.source === 'manual'; // auto-entries are read-only (S3.5 / S5.3)
}

/** Where a read-only auto-entry jumps back to (S5.3). */
export function jumpTarget(entry: Entry): { page: string; label: string } | null {
  if (entry.source === 'payroll') return { page: 'attendance', label: 'Open in Labour' };
  if (entry.source === 'billing') return { page: 'billing', label: 'Open in Billing' };
  return null;
}

export interface EditOpts {
  /** A newly picked document replaces the entry's current one. */
  attachment_file?: AttachmentInput;
  /** Drop the current document without replacing it. */
  remove_attachment?: boolean;
}

/**
 * Edit entry → regenerate its lines atomically; previous version stored in
 * edited_history (S3.5). Manual entries only; locked periods rejected (S6.1).
 * Attachment changes ride in the same write (opts).
 */
export function editEntry(id: string, type: EntryType, form: any, reason: string, opts: EditOpts = {}): Entry {
  const entries = allEntries();
  const idx = entries.findIndex((e) => e.id === id);
  if (idx < 0) throw new Error(`Entry ${id} not found.`);
  const current = entries[idx];
  if (!isEditable(current)) {
    const jump = jumpTarget(current);
    throw new Error(`Entry ${id} was created by ${current.source} and is read-only here.${jump ? ` Use “${jump.label}”.` : ''}`);
  }
  const bs = safeBs(form.date || form.ad_date || current.ad_date);
  assertNotLocked(bs, 'editing an entry');
  if (!reason?.trim()) throw new Error('A reason is required to edit an entry.');

  const drafts = recipe(type, form); // same single path as preview + save
  const totalDr = round2(drafts.reduce((s, l) => s + l.debit, 0));
  const totalCr = round2(drafts.reduce((s, l) => s + l.credit, 0));
  if (Math.abs(totalDr - totalCr) > 0.005) throw new Error(`Unbalanced entry: Dr ${totalDr} ≠ Cr ${totalCr}.`);

  // Validate the replacement before touching anything; a bad file throws here.
  const storedDoc = opts.attachment_file ? storeDocument(opts.attachment_file) : null;
  const superseded = storedDoc || opts.remove_attachment ? current.attachment || '' : '';

  const prevLines = allLines();
  const prevLinks = loadBillLinks();
  const prevDocItems = docItemsOf(id);
  const nextDate = String(form.date || form.ad_date || current.ad_date).slice(0, 10);
  const next: Entry = {
    ...current,
    type,
    ad_date: nextDate,
    bs_y: bs.year,
    bs_m: bs.month,
    bs_d: bs.day,
    attachment: storedDoc ? storedDoc.path : opts.remove_attachment ? '' : current.attachment,
    ref: String(form.ref ?? current.ref),
    note: String(form.note ?? current.note),
    due_date: resolveDueDate(nextDate, form) || undefined,
    mb_ref: String(form.mb_ref ?? current.mb_ref ?? '').trim() || undefined,
    edited_history: [
      ...current.edited_history,
      { at: new Date().toISOString(), reason: reason.trim(), entry: { ...current }, lines: prevLines.filter((l) => l.entry_id === id) },
    ].slice(-20),
  };

  const newLines: EntryLine[] = drafts.map((d, i) => ({
    id: `${id}#${i + 1}`,
    entry_id: id,
    account_id: d.account_id,
    party_id: d.party_id || '',
    worker_id: d.worker_id || '',
    project_id: d.project_id || '',
    cost_code: d.cost_code || '',
    boq_code: d.boq_code || '',
    debit: d.debit,
    credit: d.credit,
    memo: d.memo || '',
    bill_link_id: '',
  }));
  const newLinks: BillLink[] = [];
  drafts.forEach((d, i) => {
    if (d.applies_to) {
      const target = controlLineOf(d.applies_to, prevLines, d);
      newLinks.push({ payment_line_id: newLines[i].id, bill_line_id: target, applied_amount: d.debit || d.credit });
      newLines[i].bill_link_id = `${newLines[i].id}->${target}`;
    }
  });

  const nextEntries = [...entries];
  nextEntries[idx] = next;

  // A bill saved with “Paid now” owns a Payment to Supplier entry. Editing the
  // bill rewrites that payment — amount, date, reference, method and allocation
  // — in the SAME atomic write, so a paid bill can never carry a stale payment.
  const autoPay = current.type === 'supplier-bill' && current.auto_payment_id ? entryById(current.auto_payment_id) : undefined;
  let payAfter: Entry | null = null;
  let payLines: EntryLine[] = [];
  const payLinks: BillLink[] = [];
  if (autoPay) {
    try {
    if (Number(form.tds_rate) > 0) {
      throw new Error('This bill was paid when it was entered, so TDS cannot be added here. Reverse it and enter the bill again without “Paid now”.');
    }
    const payable = supplierBillPayable(drafts);
    if (!(payable > 0)) throw new Error('This bill was paid when it was entered, so it cannot be reduced to zero. Reverse it instead.');
    const oldPayLines = linesOf(autoPay.id);
    const cashLine = oldPayLines.find((l) => l.account_id === 'acc:cash' || l.account_id === 'acc:bank');
    const method = cashLine?.account_id === 'acc:bank' ? 'bank' : 'cash';
    const payForm = supplierBillPaymentForm(
      { ...form, date: nextDate, pay_date: nextDate, pay_method: method, ref: form.ref ?? current.ref },
      payable,
      id
    );
    const payDrafts = recipe('payment-supplier', payForm);
    const payBs = safeBs(nextDate);
    const payId = autoPay.id;
    payAfter = {
      ...autoPay,
      ad_date: nextDate,
      bs_y: payBs.year,
      bs_m: payBs.month,
      bs_d: payBs.day,
      ref: String(form.ref ?? current.ref),
      edited_history: [
        ...autoPay.edited_history,
        { at: new Date().toISOString(), reason: `Kept in step with bill ${id}`, entry: { ...autoPay }, lines: oldPayLines },
      ].slice(-20),
    };
    payLines = payDrafts.map((d, i) => ({
      id: `${payId}#${i + 1}`,
      entry_id: payId,
      account_id: d.account_id,
      party_id: d.party_id || '',
      worker_id: d.worker_id || '',
      project_id: d.project_id || '',
      cost_code: d.cost_code || '',
      boq_code: d.boq_code || '',
      debit: d.debit,
      credit: d.credit,
      memo: d.memo || '',
      bill_link_id: '',
    }));
    // Settle the bill's NEW payable line (the edit may have added or removed
    // lines, so the control line is resolved against the regenerated ones).
    const controlLines = [...prevLines.filter((l) => l.entry_id !== id), ...newLines];
    payDrafts.forEach((d, i) => {
      if (!d.applies_to) return;
      const target = controlLineOf(d.applies_to, controlLines, d);
      payLinks.push({ payment_line_id: payLines[i].id, bill_line_id: target, applied_amount: d.debit || d.credit });
      payLines[i].bill_link_id = `${payLines[i].id}->${target}`;
    });
    const pIdx = nextEntries.findIndex((e) => e.id === payId);
    if (pIdx >= 0) nextEntries[pIdx] = payAfter;
    } catch (err) {
      // A rejected edit must not leave the replacement document behind.
      if (storedDoc) removeDocument(storedDoc.path);
      throw err;
    }
  }

  try {
    writeJSON(ENTRIES_KEY, nextEntries);
    writeJSON(ENTRY_LINES_KEY, [
      ...prevLines.filter((l) => l.entry_id !== id && (!autoPay || l.entry_id !== autoPay.id)),
      ...newLines,
      ...payLines,
    ]);
    writeJSON(BILL_LINKS_KEY, [
      ...prevLinks.filter((l) => !l.payment_line_id.startsWith(`${id}#`) && (!autoPay || !l.payment_line_id.startsWith(`${autoPay.id}#`))),
      ...newLinks,
      ...payLinks,
    ]);
    // Keep the printed document in step with its regenerated posting.
    if (form.items) saveDocItems(id, normalizeItems(form.items));
    else removeDocItems(id);
    // Document changes are part of the same atomic edit.
    if (storedDoc || opts.remove_attachment) {
      unlinkEntryDocuments(id);
      if (next.attachment) linkDocument(id, next.attachment);
    }
  } catch (err) {
    try {
      writeJSON(ENTRIES_KEY, entries);
      writeJSON(ENTRY_LINES_KEY, prevLines);
      writeJSON(BILL_LINKS_KEY, prevLinks);
      if (prevDocItems.length) saveDocItems(id, prevDocItems);
      else removeDocItems(id);
    } finally {
      if (storedDoc) removeDocument(storedDoc.path);
    }
    throw err;
  }
  // The replaced/removed file goes only after the edit itself is committed.
  if (superseded && superseded !== next.attachment) removeDocument(superseded);
  pushAudit('edit', reason.trim(), id);
  emitChange();
  syncBoqActuals();
  return next;
}

/** Has this entry already been reversed? (a document may be reversed once) */
export function isReversed(entryId: string): boolean {
  return allEntries().some((e) => e.reversal_of === entryId);
}

/** Kathmandu "today" as a canonical A.D. date string. */
export function todayAD(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/**
 * Reverse an entry by posting its exact mirror image (S3.6). History is never
 * edited in place: the original stays visible, the pair nets to zero, and the
 * reason lands in the audit log. Auto-entries are reversed at their source.
 */
export function reverseEntry(id: string, reason: string, adDate?: string, opts: { allowStock?: boolean; cascade?: boolean } = {}): Entry {
  const entry = entryById(id);
  if (!entry) throw new Error(`Entry ${id} not found.`);
  if (entry.type === 'reversal') throw new Error('A reversal cannot itself be reversed.');
  // A payment posted with its bill moves with that bill, never on its own:
  // reversing it alone would leave the bill settled but the money back.
  if (entry.auto_bill_id && !opts.cascade) {
    throw new Error(`${id} is the payment posted with bill ${entry.auto_bill_id} — reverse that bill instead, so the pair moves together.`);
  }
  if (entry.type.startsWith('stock-') && !opts.allowStock) {
    throw new Error('Stock entries are reversed from the Inventory page, so the quantity moves with the entry.');
  }
  // Billing invoices ARE reversible: a corrected bill reverses the old invoice
  // and posts the new one, which is the only way to fix an issued document
  // without rewriting history. Payroll keeps its own reconciliation, so it is
  // corrected in the payroll run instead.
  if (entry.source === 'payroll') {
    const jump = jumpTarget(entry);
    throw new Error(`Entry ${id} was created by payroll — ${jump ? `use “${jump.label}”` : 'correct it in the payroll run'}.`);
  }
  if (isReversed(id)) throw new Error(`${id} is already reversed.`);
  if (!reason?.trim()) throw new Error('A reason is required to reverse an entry.');

  const date = String(adDate || todayAD()).slice(0, 10);
  const autoPayId = entry.type === 'supplier-bill' ? entry.auto_payment_id : undefined;
  // Reversing a paid bill reverses its payment too, in one action: no orphaned
  // payment and no supplier balance left behind either way.
  const snapshot = autoPayId ? { entries: allEntries(), lines: allLines(), links: loadBillLinks() } : null;
  try {
    if (autoPayId && entryById(autoPayId) && !isReversed(autoPayId)) {
      reverseEntry(autoPayId, `Auto-payment of ${id}: ${reason.trim()}`, date, { ...opts, cascade: true });
    }
    const reversed = saveEntry(
      'reversal',
      { date, reverses: id, ref: entry.ref, note: `Reversal of ${id}: ${reason.trim()}` },
      { source: 'manual' }
    );
    pushAudit('edit', `Reversal of ${id}: ${reason.trim()}`, reversed.id);
    return reversed;
  } catch (err) {
    if (snapshot) {
      writeJSON(ENTRIES_KEY, snapshot.entries);
      writeJSON(ENTRY_LINES_KEY, snapshot.lines);
      writeJSON(BILL_LINKS_KEY, snapshot.links);
      emitChange();
    }
    throw err;
  }
}

/** Best-effort form reconstruction for the hopper's edit mode (S3.5). */
export function formForEntry(entry: Entry): { type: EntryType; form: any } {
  const lines = linesOf(entry.id);
  const base = { date: entry.ad_date, ref: entry.ref, note: entry.note, attachment: entry.attachment, mb_ref: entry.mb_ref || '' };
  const dr = lines.find((l) => l.debit > 0);
  const cr = lines.find((l) => l.credit > 0);
  const cashLine = lines.find((l) => ['acc:cash', 'acc:bank'].includes(l.account_id));
  const method = cashLine ? (cashLine.account_id === 'acc:bank' ? 'bank' : 'cash') : 'cash';
  const amount = round2(lines.reduce((s, l) => s + l.debit, 0));
  switch (entry.type) {
    case 'expense-paid':
      return { type: entry.type, form: { ...base, category: dr?.cost_code || accountName(dr?.account_id || ''), project: dr?.project_id === 'overhead' ? '' : dr?.project_id, boq_code: dr?.boq_code || '', amount, method } };
    case 'supplier-bill': {
      // Reconstruct the tax so editing a taxed bill never silently drops VAT/TDS.
      const baseAmount = dr?.debit || 0;
      const vat = round2(lines.filter((l) => l.account_id === 'acc:vat-input').reduce((s, l) => s + l.debit, 0));
      const tds = round2(lines.filter((l) => l.account_id === 'acc:tds-payable').reduce((s, l) => s + l.credit, 0));
      return {
        type: entry.type,
        form: {
          ...base,
          supplier: cr?.party_id || '',
          cost_code: dr?.cost_code || accountName(dr?.account_id || ''),
          project: dr?.project_id || '',
          boq_code: dr?.boq_code || '',
          amount: round2(baseAmount + vat),
          qty: '',
          rate: '',
          due_days: (cr?.memo || '').replace(/\D+/g, ''),
          vat_rate: baseAmount > 0 && vat > 0 ? round2((vat * 100) / baseAmount) : 0,
          tds_rate: baseAmount > 0 && tds > 0 ? round2((tds * 100) / baseAmount) : 0,
          // Item detail drives the form when the bill was entered that way.
          items: docItemsOf(entry.id),
        },
      };
    }
    case 'purchase-return': {
      const supplier = lines.find((l) => l.account_id === 'acc:ap')?.party_id || '';
      const vat = round2(lines.filter((l) => l.account_id === 'acc:vat-input').reduce((s, l) => s + l.credit, 0));
      const expense = round2(lines.filter((l) => accountName(l.account_id) && l.credit > 0 && l.account_id.startsWith('acc:exp:')).reduce((s, l) => s + l.credit, 0));
      return {
        type: entry.type,
        form: {
          ...base,
          supplier,
          project: lines.find((l) => l.project_id)?.project_id || '',
          vat_rate: expense > 0 && vat > 0 ? round2((vat * 100) / expense) : 0,
          items: docItemsOf(entry.id),
        },
      };
    }
    case 'credit-note': {
      const client = lines.find((l) => l.account_id === 'acc:ar')?.party_id || '';
      const income = round2(lines.filter((l) => l.account_id === 'acc:income').reduce((s, l) => s + l.debit, 0));
      const vat = round2(lines.filter((l) => l.account_id === 'acc:vat-output').reduce((s, l) => s + l.debit, 0));
      return {
        type: entry.type,
        form: {
          ...base,
          client,
          project: lines.find((l) => l.project_id)?.project_id || '',
          vat_rate: income > 0 && vat > 0 ? round2((vat * 100) / income) : 0,
          items: docItemsOf(entry.id),
        },
      };
    }
    case 'payment-supplier':
      return { type: entry.type, form: { ...base, supplier: dr?.party_id || '', amount, method, allocations: [] } };
    case 'client-receipt':
      return { type: entry.type, form: { ...base, client: dr?.party_id || '', amount, method, retention_release: 0, allocations: [] } };
    case 'client-invoice': {
      const income = round2(lines.filter((l) => l.account_id === 'acc:income').reduce((s, l) => s + l.credit, 0));
      const vat = round2(lines.filter((l) => l.account_id === 'acc:vat-output').reduce((s, l) => s + l.credit, 0));
      const retention = round2(lines.filter((l) => l.account_id === 'acc:retention-ar').reduce((s, l) => s + l.debit, 0));
      return {
        type: entry.type,
        form: {
          ...base,
          client: dr?.party_id || '',
          project: dr?.project_id || '',
          amount: round2(income + vat),
          retention_pct: income > 0 ? round2((retention * 100) / income) : 0,
          vat_rate: income > 0 && vat > 0 ? round2((vat * 100) / income) : 0,
          items: docItemsOf(entry.id),
        },
      };
    }
    case 'worker-advance':
      return { type: entry.type, form: { ...base, worker_id: dr?.worker_id || '', worker_name: accountName(dr?.account_id || ''), amount: dr?.debit || 0, method } };
    case 'client-advance':
      return { type: entry.type, form: { ...base, client: cr?.party_id || '', project: cr?.project_id || '', amount: dr?.debit || 0, method } };
    case 'opening-balance': {
      const partyLine = lines.find((l) => l.party_id);
      const target = lines.some((l) => l.account_id === 'acc:cash')
        ? 'cash'
        : lines.some((l) => l.account_id === 'acc:bank')
          ? 'bank'
          : lines.some((l) => l.account_id === 'acc:ar')
            ? 'receivable'
            : 'payable';
      return { type: entry.type, form: { ...base, account: target, party: partyLine?.party_id || '', project: partyLine?.project_id || '', amount: Math.max(...lines.map((l) => l.debit || l.credit)) } };
    }
    case 'transfer':
      return { type: entry.type, form: { ...base, from: cr?.account_id === 'acc:bank' ? 'bank' : 'cash', to: dr?.account_id === 'acc:cash' ? 'cash' : 'bank', amount: dr?.debit || 0 } };
    case 'owner-loan-in':
      return { type: entry.type, form: { ...base, source: cr?.account_id === 'acc:loan' ? 'loan' : 'owner', amount: dr?.debit || 0, method } };
    case 'adjustment':
      return { type: entry.type, form: { ...base, debit_account: dr?.account_id || '', credit_account: cr?.account_id || '', amount: dr?.debit || 0, note: entry.note } };
    default:
      return { type: entry.type, form: { ...base, amount, account_id: dr?.account_id || 'acc:cash' } };
  }
}

// ---------------------------------------------------------------------------
// Trial balance (S4.5 / S6.3)
// ---------------------------------------------------------------------------
export interface TrialBalance {
  totalDebit: number;
  totalCredit: number;
  difference: number;
  balanced: boolean;
}
export function trialBalance(): TrialBalance {
  const lines = allLines();
  const totalDebit = round2(lines.reduce((s, l) => s + l.debit, 0));
  const totalCredit = round2(lines.reduce((s, l) => s + l.credit, 0));
  const difference = round2(totalDebit - totalCredit);
  return { totalDebit, totalCredit, difference, balanced: Math.abs(difference) < 0.005 };
}

// ---------------------------------------------------------------------------
// Period helpers for views (S4.6)
// ---------------------------------------------------------------------------
export interface Period {
  year: number;
  month: number;
}

export function entryInPeriod(e: Entry, p: Period): boolean {
  return e.bs_y === p.year && e.bs_m === p.month;
}

// ---------------------------------------------------------------------------
// Feed (S4.1) — capture history → entry history
// ---------------------------------------------------------------------------
export interface FeedRow {
  entry: Entry;
  amount: number;
  party: string;
  accounts: string[]; // routing badges (account names)
  locked: boolean;
  editable: boolean;
  reversed: boolean;
  reversalOf: string;
}
export function feed(p?: Period): FeedRow[] {
  const lines = allLines();
  const locks = loadMeta().locks;
  const reversedIds = new Set(allEntries().map((e) => e.reversal_of).filter(Boolean) as string[]);
  return allEntries()
    .filter((e) => (p ? entryInPeriod(e, p) : true))
    .slice()
    .sort((a, b) => b.ad_date.localeCompare(a.ad_date) || b.id.localeCompare(a.id))
    .map((e) => {
      const ls = lines.filter((l) => l.entry_id === e.id);
      const partyLine = ls.find((l) => l.party_id) || ls.find((l) => l.worker_id);
      const accountIds = [...new Set(ls.map((l) => l.account_id))];
      return {
        entry: e,
        amount: round2(ls.reduce((s, l) => s + l.debit, 0)),
        party: partyLine?.party_id || (partyLine?.worker_id ? accountName(partyLine.account_id) : ''),
        accounts: accountIds.map(accountName),
        locked: Boolean(locks[periodKey(e.bs_y, e.bs_m)]),
        editable: isEditable(e),
        reversed: reversedIds.has(e.id),
        reversalOf: e.reversal_of || '',
      };
    });
}

// ---------------------------------------------------------------------------
// Parties (S4.3) — balances = Σ of that party's lines; aging buckets
// ---------------------------------------------------------------------------
export interface PartyRow {
  party_id: string;
  receivable: number;
  payable: number;
  aging: { b0_30: number; b31_60: number; b61: number };
  openBills: { id: string; ad_date: string; due: string; outstanding: number; kind: 'bill' | 'invoice' }[];
}

export function parties(p: Period): PartyRow[] {
  const { to } = periodAdRange({ year: p.year, month: p.month } as BSPeriod);
  const captures = new Map(allEntries().map((e) => [e.id, e] as const));
  const lines = allLines();
  const links = loadBillLinks();
  const byParty = new Map<string, PartyRow>();
  const row = (id: string): PartyRow => {
    if (!byParty.has(id)) byParty.set(id, { party_id: id, receivable: 0, payable: 0, aging: { b0_30: 0, b31_60: 0, b61: 0 }, openBills: [] });
    return byParty.get(id)!;
  };
  for (const l of lines) {
    if (!l.party_id) continue;
    const r = row(l.party_id);
    if (l.account_id === 'acc:ar' || l.account_id === 'acc:retention-ar') r.receivable = round2(r.receivable + l.debit - l.credit);
    if (l.account_id === 'acc:ap') r.payable = round2(r.payable + l.credit - l.debit);
  }
  // Aging: open bill/invoice entries, bucketed by age past due as of period end.
  for (const r of byParty.values()) {
    for (const c of captures.values()) {
      if (c.type !== 'supplier-bill' && c.type !== 'client-invoice') continue;
      if (isReversed(c.id)) continue; // a reversed document is no longer open
      const capLines = lines.filter((l) => l.entry_id === c.id);
      const partyLine = capLines.find((l) => l.party_id === r.party_id);
      if (!partyLine) continue;
      // Σ, not “the last matching line”: a bill with a round-off or TDS line
      // after its payable must still show what is open.
      const gross = round2(capLines.reduce((s, l) => s + (l.account_id === 'acc:ap' ? l.credit : l.account_id === 'acc:ar' || l.account_id === 'acc:retention-ar' ? l.debit : 0), 0));
      const applied = round2(links.filter((lk) => lk.bill_line_id.startsWith(`${c.id}#`)).reduce((s, lk) => s + lk.applied_amount, 0));
      const outstanding = round2(gross - applied);
      if (!(outstanding > 0)) continue;
      const dueDays = Number((capLines.find((l) => l.memo?.startsWith('Due in'))?.memo || '').replace(/\D+/g, '')) || 0;
      // The document's own due date is the fact; the memo is only a fallback
      // for documents written before due dates were stored.
      const due = c.due_date || addDays(c.ad_date, dueDays);
      const age = Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86400000);
      if (age <= 30) r.aging.b0_30 = round2(r.aging.b0_30 + outstanding);
      else if (age <= 60) r.aging.b31_60 = round2(r.aging.b31_60 + outstanding);
      else r.aging.b61 = round2(r.aging.b61 + outstanding);
      r.openBills.push({ id: c.id, ad_date: c.ad_date, due, outstanding, kind: c.type === 'supplier-bill' ? 'bill' : 'invoice' });
    }
    r.openBills.sort((a, b) => a.due.localeCompare(b.due));
  }
  return [...byParty.values()].sort((a, b) => b.receivable + b.payable - (a.receivable + a.payable));
}

/** Party statement (S4.3): bills, payments, settlements, running balance. */
export interface StatementLine {
  ad_date: string;
  voucher: string;
  type: EntryType;
  label: string;
  debit: number;
  credit: number;
  balance: number;
  settled: number; // from bill_links for this line
}
export function partyStatement(partyId: string): StatementLine[] {
  const links = loadBillLinks();
  const rows: StatementLine[] = [];
  let balance = 0;
  for (const e of allEntries().slice().sort((a, b) => a.ad_date.localeCompare(b.ad_date) || a.id.localeCompare(b.id))) {
    for (const l of linesOf(e.id)) {
      if (l.party_id !== partyId) continue;
      if (!['acc:ap', 'acc:ar', 'acc:retention-ar'].includes(l.account_id)) continue;
      const settled = round2(links.filter((lk) => lk.bill_line_id === l.id).reduce((s, lk) => s + lk.applied_amount, 0));
      balance = round2(balance + (l.account_id === 'acc:ap' ? l.credit - l.debit : l.debit - l.credit));
      rows.push({ ad_date: e.ad_date, voucher: e.id, type: e.type, label: l.memo || e.ref || e.id, debit: l.debit, credit: l.credit, balance, settled });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Daybook (S4.2) — cash/bank lines only
// ---------------------------------------------------------------------------
export interface DaybookRow {
  ad_date: string;
  bs_y: number; bs_m: number; bs_d: number;
  voucher: string;
  type: EntryType;
  party: string;
  account: 'cash' | 'bank';
  in: number;
  out: number;
  balance: number;
}
function cashFlow(account: 'cash' | 'bank', p?: Period): { opening: number; rows: DaybookRow[]; closing: number } {
  const accId = account === 'bank' ? 'acc:bank' : 'acc:cash';
  const entryMap = new Map(allEntries().map((e) => [e.id, e] as const));
  const all = allLines()
    .filter((l) => l.account_id === accId)
    .map((l) => ({ l, e: entryMap.get(l.entry_id)! }))
    .filter((x) => x.e)
    .sort((a, b) => a.e.ad_date.localeCompare(b.e.ad_date) || a.l.id.localeCompare(b.l.id));
  const opening = p
    ? round2(all.filter((x) => x.e.bs_y < p.year || (x.e.bs_y === p.year && x.e.bs_m < p.month)).reduce((s, x) => s + x.l.debit - x.l.credit, 0))
    : 0;
  let balance = p ? opening : 0;
  const rows: DaybookRow[] = [];
  for (const { l, e } of all) {
    if (p && !entryInPeriod(e, p)) continue;
    const amount = round2(l.debit - l.credit);
    balance = round2(balance + amount);
    rows.push({
      ad_date: e.ad_date, bs_y: e.bs_y, bs_m: e.bs_m, bs_d: e.bs_d,
      voucher: e.id, type: e.type,
      party: l.party_id || partyOfEntry(e.id),
      account, in: amount > 0 ? amount : 0, out: amount < 0 ? round2(-amount) : 0, balance,
    });
  }
  return { opening, rows, closing: balance };
}
export function daybook(account: 'cash' | 'bank', p: Period): { opening: number; rows: DaybookRow[]; closing: number } {
  return cashFlow(account, p);
}
/** Cumulative balance of an account strictly before the period (S4.6). */
export function openingBalance(account: 'cash' | 'bank', p: Period): number {
  return cashFlow(account, p).opening;
}
/** Cumulative closing of an account through the period end (used by parity). */
export function cumulativeClosing(account: 'cash' | 'bank', p: Period): number {
  return cashFlow(account, p).closing;
}

export function partyOfEntry(entryId: string): string {
  const l = allLines().find((x) => x.entry_id === entryId && x.party_id);
  return l?.party_id || '';
}

// ---------------------------------------------------------------------------
// Job Cost (S4.4) — per project: accrued vs paid vs budget, read-only
// ---------------------------------------------------------------------------
export interface JobCostRow {
  project_id: string;
  accrued: number;
  paid: number;
  budget: number;
  variance: number;
  committed: number; // open POs + subcontracts
  forecast: number; // accrued + committed
}
export function jobCost(): JobCostRow[] {
  const links = loadBillLinks();
  const lines = allLines();
  const rows = new Map<string, JobCostRow>();
  const row = (id: string): JobCostRow => {
    const key = id || 'overhead';
    if (!rows.has(key)) rows.set(key, { project_id: key, accrued: 0, paid: 0, budget: projectBudget(key), variance: 0, committed: 0, forecast: 0 });
    return rows.get(key)!;
  };
  for (const l of lines) {
    const kind = accountKind(l.account_id);
    // Net, not gross: a reversal (or a refund) credits the expense account and
    // must reduce the job's cost, or the reversal would look like new spending.
    if (kind === 'expense' && l.project_id) row(l.project_id).accrued = round2(row(l.project_id).accrued + l.debit - l.credit);
    if ((kind === 'cash' || kind === 'bank') && l.project_id && l.credit > 0) row(l.project_id).paid = round2(row(l.project_id).paid + l.credit);
  }
  // Payments applied to bills whose expense line carries a project.
  for (const lk of links) {
    const billId = lk.bill_line_id.split('#')[0];
    const project = lines.find((l) => l.entry_id === billId && l.project_id && accountKind(l.account_id) === 'expense')?.project_id;
    if (project) row(project).paid = round2(row(project).paid + lk.applied_amount);
  }
  // Committed cost: promised, not yet invoiced. The forecast is cost to date
  // plus commitments, so a job with POs but no invoices still forecasts.
  const committed = committedByKey();
  for (const key of committed.keys()) {
    const projectId = key.split('|')[0];
    if (projectId) row(projectId);
  }
  for (const r of rows.values()) {
    let sum = 0;
    for (const [key, amount] of committed) if (key.startsWith(`${r.project_id}|`)) sum += amount;
    r.committed = round2(sum);
    r.forecast = round2(r.accrued + sum);
  }
  for (const r of rows.values()) r.variance = round2(r.accrued - r.paid);
  return [...rows.values()].sort((a, b) => a.project_id.localeCompare(b.project_id));
}

/** Budget per project from that project's BOQ (Job Costing consumes this). */
export function projectBudget(projectId: string): number {
  if (projectId === 'overhead') return 0;
  const boq = readScoped<any[]>('contractoros_boq', [], projectId);
  const total = (boq || []).reduce((s: number, sec: any) => s + (sec.amount || 0) + (sec.children || []).reduce((t: number, c: any) => t + (c.amount || 0), 0), 0);
  return round2(total);
}

// ---------------------------------------------------------------------------
// Job cost by cost code (project × cost code roll-up)
//
// `jobCost()` answers "what did the job cost". This answers the question job
// costing exists for: "which cost code on which job is over". Budgets come
// from BOQ items that carry a cost code, so tagging BOQ items is what turns a
// contract value into a cost-budget baseline.
// ---------------------------------------------------------------------------
export interface JobCostCodeRow {
  project_id: string;
  code: string;
  cost_code: string;
  name: string;
  kind: CostCodeKind;
  accrued: number;
  committed: number;
  forecast: number; // accrued + committed
  budget: number;
  variance: number; // budget − accrued
  forecastVariance: number; // budget − forecast
}

export interface JobCostProjectRow {
  project_id: string;
  name: string;
  accrued: number;
  paid: number;
  budget: number;
  committed: number;
  forecast: number;
}

export interface JobCostBreakdown {
  projects: JobCostProjectRow[];
  codes: JobCostCodeRow[];
}

/** Expense debits grouped by project AND cost code, with BOQ-tagged budgets. */
export function jobCostByCode(projectFilter?: string): JobCostBreakdown {
  const kindById = new Map(loadAccounts().map((a) => [a.id, a.kind] as const));
  const codes = loadCostCodes();
  const resolve = (value: string) => {
    const key = String(value || '').trim();
    if (!key) return null;
    return codes.find((c) => c.code === key) || codes.find((c) => c.name.toLowerCase() === key.toLowerCase()) || null;
  };

  const projects: JobCostProjectRow[] = jobCost().map((r) => ({
    project_id: r.project_id,
    name: r.project_id === 'overhead' ? 'Overhead (unallocated)' : projectNameOf(r.project_id),
    accrued: r.accrued,
    paid: r.paid,
    budget: r.budget,
    committed: r.committed,
    forecast: r.forecast,
  }));

  const byKey = new Map<string, JobCostCodeRow>();
  const rowFor = (projectId: string, code: string, fallbackName: string, kind: CostCodeKind) => {
    const key = `${projectId}|${code}`;
    let row = byKey.get(key);
    if (!row) {
      row = { project_id: projectId, code, cost_code: fallbackName, name: fallbackName, kind, accrued: 0, committed: 0, forecast: 0, budget: 0, variance: 0, forecastVariance: 0 };
      byKey.set(key, row);
    }
    return row;
  };

  for (const l of allLines()) {
    if (!l.project_id) continue;
    if (kindById.get(l.account_id) !== 'expense') continue;
    if (projectFilter && l.project_id !== projectFilter) continue;
    if (l.debit === 0 && l.credit === 0) continue;
    const cc = resolve(l.cost_code);
    const row = rowFor(l.project_id, cc?.code || '0000', cc ? cc.name : l.cost_code || 'Unassigned', cc?.kind || 'other');
    row.accrued = round2(row.accrued + l.debit - l.credit);
    row.cost_code = l.cost_code || row.cost_code;
  }

  // Budget baseline: each project's own BOQ items tagged with a cost code.
  const budgetProjects = projectFilter
    ? [projectFilter]
    : [...new Set([...byKey.values()].map((r) => r.project_id))];
  for (const pid of budgetProjects) {
    for (const item of loadBoqItems(pid)) {
      const cc = item.costCode ? resolve(item.costCode) : null;
      if (!cc) continue;
      const row = rowFor(pid, cc.code, cc.name, cc.kind);
      row.budget = round2(row.budget + item.amount);
    }
  }

  // Join open commitments onto the same project × cost-code dimension. A code
  // with commitments but no invoice yet still belongs in the forecast.
  const committed = committedByKey();
  for (const [key, amount] of committed) {
    const [projectId, code] = key.split('|');
    if (!projectId || !code) continue;
    if (projectFilter && projectId !== projectFilter) continue;
    const cc = resolve(code);
    const row = rowFor(projectId, code, cc ? cc.name : code, cc?.kind || 'other');
    row.committed = round2(row.committed + amount);
  }
  for (const r of byKey.values()) r.forecast = round2(r.accrued + r.committed);

  const out = [...byKey.values()]
    .map((r) => ({
      ...r,
      variance: round2(r.budget - r.accrued),
      forecastVariance: round2(r.budget - r.forecast),
    }))
    .filter((r) => r.accrued !== 0 || r.budget !== 0 || r.committed !== 0)
    .sort((a, b) => a.project_id.localeCompare(b.project_id) || a.code.localeCompare(b.code));

  return { projects: projects.filter((p) => !projectFilter || p.project_id === projectFilter), codes: out };
}

/** Adopt unknown project/cost-code values instead of rejecting the posting. */
function registerDimensions(projectId?: string, costCode?: string) {
  const p = String(projectId || '').trim();
  if (p && p.toLowerCase() !== 'overhead' && p.toLowerCase() !== 'general') ensureProject(p);
  const c = String(costCode || '').trim();
  if (c) ensureCostCode(c);
}

/**
 * Write postings back to BOQ items (actualMaterialCost / actualLaborCost).
 * Derived, not incremental: each call recomputes from entry_lines, so edits and
 * deletions can never double-count. Items with no BOQ-linked posting go to 0 —
 * but only once the first such posting exists, so an untouched BOQ document is
 * left exactly as imported.
 */
export function syncBoqActuals(): { updated: number } {
  const kindById = new Map(loadAccounts().map((a) => [a.id, a.kind] as const));
  const linked = allLines().filter((l) => l.boq_code && (l.debit > 0 || l.credit > 0) && kindById.get(l.account_id) === 'expense');
  if (linked.length === 0) return { updated: 0 };

  // Postings write back to THEIR project's BOQ — never the active project's.
  const byProject = new Map<string, typeof linked>();
  for (const line of linked) {
    const projectId = (line.project_id || DEFAULT_PROJECT_ID).toUpperCase();
    const bucket = byProject.get(projectId) || [];
    bucket.push(line);
    byProject.set(projectId, bucket);
  }

  let totalUpdated = 0;
  for (const [projectId, lines] of byProject) {
    const boq = readScoped<any[]>('contractoros_boq', [], projectId);
    if (!Array.isArray(boq) || boq.length === 0) continue;

    const agg = new Map<string, { material: number; labour: number }>();
    for (const l of lines) {
      const bucket = agg.get(l.boq_code!) || { material: 0, labour: 0 };
      const net = round2(l.debit - l.credit);
      if (costCodeOf(l.cost_code)?.kind === 'labour') bucket.labour = round2(bucket.labour + net);
      else bucket.material = round2(bucket.material + net);
      agg.set(l.boq_code!, bucket);
    }

    let updated = 0;
    const next = boq.map((section: any) => ({
      ...section,
      children: (section?.children || []).map((item: any) => {
        const a = agg.get(String(item.itemCode));
        const actualMaterialCost = round2(a?.material || 0);
        const actualLaborCost = round2(a?.labour || 0);
        if ((Number(item.actualMaterialCost) || 0) === actualMaterialCost && (Number(item.actualLaborCost) || 0) === actualLaborCost) return item;
        updated++;
        return { ...item, actualMaterialCost, actualLaborCost };
      }),
    }));

    if (updated > 0) {
      writeScoped('contractoros_boq', next, projectId);
      totalUpdated += updated;
    }
  }

  if (totalUpdated > 0 && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('contractoros:boq-changed'));
  }
  return { updated: totalUpdated };
}

// ---------------------------------------------------------------------------
// WIP (percentage of completion)
//
// Cost-to-cost POC:  % complete = cost to date ÷ estimated cost at completion
// Earned revenue  =  % complete × contract value
// Over/(under)    =  billings to date − earned revenue
//   over-billed  (> 0) = liability: billings in excess of cost and earnings
//   under-billed (< 0) = asset:    cost and earnings in excess of billings
// Cumulative to `toAD` (inclusive); omit it for everything booked so far.
// ---------------------------------------------------------------------------
export interface WipRow {
  project_id: string;
  name: string;
  contract: number;
  costToDate: number;
  estimatedCost: number;
  pctComplete: number; // 0-1, may exceed 1 on a cost overrun
  earnedRevenue: number;
  billings: number;
  retention: number; // outstanding retention receivable
  overUnder: number; // billings − earned; > 0 over-billed
  grossProfit: number; // earned − cost to date
  complete: boolean; // estimated cost at completion declared?
}

export interface WipReport {
  asOf: string;
  rows: WipRow[];
  totals: Omit<WipRow, 'project_id' | 'name' | 'complete'>;
}

export function wipReport(toAD?: string): WipReport {
  const to = String(toAD || '').slice(0, 10);
  const entries = allEntries();
  const included = new Map(entries.map((e) => [e.id, e] as const));
  const lines = allLines();
  const kindById = new Map(loadAccounts().map((a) => [a.id, a.kind] as const));

  const cost = new Map<string, number>();
  const billed = new Map<string, number>();
  const retention = new Map<string, number>();
  const touched = new Set<string>();

  for (const l of lines) {
    const entry = included.get(l.entry_id);
    if (!entry) continue;
    if (to && entry.ad_date > to) continue;
    const project = String(l.project_id || '').trim();
    if (!project || project === 'overhead' || project === 'general') continue;

    if (l.account_id === 'acc:income' && l.credit > 0) {
      billed.set(project, round2((billed.get(project) || 0) + l.credit));
      touched.add(project);
    }
    if (l.account_id === 'acc:retention-ar') {
      retention.set(project, round2((retention.get(project) || 0) + l.debit - l.credit));
      touched.add(project);
    }
    if (kindById.get(l.account_id) === 'expense') {
      cost.set(project, round2((cost.get(project) || 0) + l.debit - l.credit));
      touched.add(project);
    }
  }

  // Any mastered job with a contract or estimates belongs on the schedule even
  // before its first cost lands.
  for (const p of loadProjects()) {
    if ((Number(p.contractValue) || 0) > 0 || (Number(p.estimatedCost) || 0) > 0) touched.add(p.id);
  }

  const rows: WipRow[] = [...touched].sort().map((projectId) => {
    const contract = contractValueOf(projectId);
    const estimatedCost = estimatedCostOf(projectId);
    const costToDate = round2(cost.get(projectId) || 0);
    const billings = round2(billed.get(projectId) || 0);
    const complete = estimatedCost > 0;
    const pctComplete = complete ? costToDate / estimatedCost : 0;
    const earnedRevenue = round2(contract * pctComplete);
    return {
      project_id: projectId,
      name: projectNameOf(projectId),
      contract,
      costToDate,
      estimatedCost,
      pctComplete,
      earnedRevenue,
      billings,
      retention: round2(retention.get(projectId) || 0),
      overUnder: round2(billings - earnedRevenue),
      grossProfit: round2(earnedRevenue - costToDate),
      complete,
    };
  });

  const sum = (key: keyof WipRow) => round2(rows.reduce((s, r) => s + (Number(r[key]) || 0), 0));
  const totals = {
    contract: sum('contract'),
    costToDate: sum('costToDate'),
    estimatedCost: sum('estimatedCost'),
    pctComplete: 0,
    earnedRevenue: sum('earnedRevenue'),
    billings: sum('billings'),
    retention: sum('retention'),
    overUnder: sum('overUnder'),
    grossProfit: sum('grossProfit'),
  };
  totals.pctComplete = totals.estimatedCost > 0 ? totals.costToDate / totals.estimatedCost : 0;

  return { asOf: to || todayAD(), rows, totals };
}

// ---------------------------------------------------------------------------
// Statements (S4.5) — per-account statement + category summary
// ---------------------------------------------------------------------------
export interface StatementRow {
  ad_date: string;
  bs_y: number; bs_m: number; bs_d: number;
  voucher: string;
  type: EntryType;
  party: string;
  in: number;
  out: number;
  balance: number;
}
export function accountStatement(account: 'cash' | 'bank', p: Period): { opening: number; rows: StatementRow[]; closing: number } {
  const flow = cashFlow(account, p);
  return { opening: flow.opening, rows: flow.rows, closing: flow.closing };
}

/** Category summary for Statements (S4.5): expense Σ by category in period. */
export function categorySummary(p: Period): { category: string; amount: number }[] {
  const entryMap = new Map(allEntries().map((e) => [e.id, e] as const));
  const out = new Map<string, number>();
  for (const l of allLines()) {
    const e = entryMap.get(l.entry_id);
    if (!e || !entryInPeriod(e, p)) continue;
    if (accountKind(l.account_id) !== 'expense') continue;
    const name = accountName(l.account_id);
    out.set(name, round2((out.get(name) || 0) + l.debit - l.credit));
  }
  return [...out.entries()].map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount);
}

// ---------------------------------------------------------------------------
// Reconciliation (S4.6)
// ---------------------------------------------------------------------------
export interface LabourTotals {
  advancesPosted: number;
  payrollPosted: number;
  pendingRuns: number;
}
export interface Reconciliation {
  ledgerOut: number; // Σ books cash/bank out for worker-advance + payroll-payment
  labourSide: number; // Σ labour_tx advances + payments
  difference: number;
  status: 'green' | 'amber' | 'red';
}
export function computeReconciliation(labour: LabourTotals): Reconciliation {
  const ledgerOut = round2(
    allEntries()
      .filter((e) => e.type === 'worker-advance' || e.type === 'payroll-payment')
      .reduce((s, e) => s + linesOf(e.id).reduce((t, l) => t + l.credit, 0), 0)
  );
  const labourSide = round2((labour.advancesPosted || 0) + (labour.payrollPosted || 0));
  const difference = round2(ledgerOut - labourSide);
  const status: Reconciliation['status'] =
    Math.abs(difference) >= 0.005 ? 'red' : (labour.pendingRuns || 0) > 0 ? 'amber' : 'green';
  return { ledgerOut, labourSide, difference, status };
}

export interface Chip {
  label: string;
  status: 'green' | 'amber' | 'red';
  detail: string;
}
export function labourChip(labour: LabourTotals): Chip {
  const rec = computeReconciliation(labour);
  return {
    label: 'Labour matched',
    status: rec.status,
    detail: `books ${rec.ledgerOut.toLocaleString()} vs labour ${rec.labourSide.toLocaleString()}${labour.pendingRuns ? ` (${labour.pendingRuns} pending run)` : ''}`,
  };
}
export function billingChip(): Chip {
  // Live invoices only (a reversed one is superseded) and every job's bills,
  // because the ledger is company-wide: reading just the active project's
  // billing rows made the chip go red the moment a second job invoiced.
  const invoiced = round2(
    allEntries()
      .filter((e) => e.source === 'billing' && e.type === 'client-invoice' && !isReversed(e.id))
      .reduce((s, e) => s + linesOf(e.id).reduce((t, l) => t + (l.account_id === 'acc:income' ? l.credit - l.debit : 0), 0), 0)
  );
  let billingTotal = 0;
  try {
    const ids = loadProjects().map((p) => p.id);
    for (const projectId of ids.length ? ids : [getActiveProject()]) {
      const rows = readScoped<any[]>('contractoros_billing_entries', [], projectId) || [];
      // A draft has not been invoiced yet, so it cannot be expected in the books.
      billingTotal += rows
        .filter((r: any) => (r?.docStatus ?? r?.data?.docStatus ?? 'draft') !== 'draft')
        .reduce((s: number, r: any) => s + (Number(r?.netAmount) || 0), 0);
    }
    billingTotal = round2(billingTotal);
  } catch {
    billingTotal = 0;
  }
  const diff = round2(invoiced - billingTotal);
  return { label: 'Billing matched', status: Math.abs(diff) < 0.005 ? 'green' : 'red', detail: `invoices ${invoiced.toLocaleString()} vs billing ${billingTotal.toLocaleString()}` };
}

// ---------------------------------------------------------------------------
// Auto-sources called from Labour / Billing (S5)
// ---------------------------------------------------------------------------
export function payrollAccrualEntry(form: { date: string; ref: string; workers: { worker_id: string; name?: string; amount: number }[]; project_splits: { project_id: string; amount: number }[]; note?: string }): Entry {
  return saveEntry('payroll-accrual', { date: form.date, ref: form.ref, note: form.note || `Payroll accrual ${form.ref}`, workers: form.workers, project_splits: form.project_splits }, { source: 'payroll' });
}
export function payrollPaymentEntry(form: { date: string; ref: string; workers: { worker_id: string; name?: string; amount: number; method?: string }[]; note?: string }): Entry {
  return saveEntry('payroll-payment', { date: form.date, ref: form.ref, note: form.note || `Payroll payment ${form.ref}`, workers: form.workers }, { source: 'payroll' });
}
export function billingInvoiceEntry(form: { billId: string; client: string; amount: number; date: string; project?: string; retention_pct?: number }): Entry | null {
  if (entriesForRef(form.billId).some((e) => e.source === 'billing' && e.type === 'client-invoice')) return null; // idempotent
  if (!(Number(form.amount) > 0)) return null;
  return saveEntry('client-invoice', { date: form.date, ref: form.billId, client: form.client, amount: Number(form.amount), project: form.project || '', retention_pct: form.retention_pct || 0, note: `Invoice ${form.billId}` }, { source: 'billing' });
}
export function billingReceiptEntry(form: { billId: string; client: string; amount: number; date: string; retention_release?: number; project?: string }): Entry | null {
  if (entriesForRef(form.billId).some((e) => e.source === 'billing' && e.type === 'client-receipt' && !isReversed(e.id))) return null; // idempotent
  if (!(Number(form.amount) > 0)) return null;
  return saveEntry('client-receipt', { date: form.date, ref: form.billId, client: form.client, amount: Number(form.amount), method: 'bank', retention_release: form.retention_release || 0, note: `Receipt ${form.billId}` }, { source: 'billing' });
}

// ---------------------------------------------------------------------------
// Billing ↔ ledger link (S5.2, contractor: "keep both, link them")
//
// The billing screen keeps its own document, and the ledger keeps the only
// entry that matters. The link is the bill id carried as the entry's `ref`, so
// no second store can drift from either side. What the link guarantees:
//   • one live invoice per bill (posting twice is impossible)
//   • a changed amount never silently diverges: the old invoice is REVERSED and
//     the corrected one posted, so history and the trial balance stay honest
//   • every bill can report what the books say about it
// ---------------------------------------------------------------------------
function liveEntriesForRef(ref: string, type: EntryType): Entry[] {
  return allEntries().filter((e) => e.ref === ref && e.type === type && !isReversed(e.id));
}

function revenueOf(entry: Entry): number {
  return round2(linesOf(entry.id).reduce((t, l) => t + (l.account_id === 'acc:income' ? l.credit - l.debit : 0), 0));
}

function cashInOf(entry: Entry): number {
  return round2(
    linesOf(entry.id).reduce((t, l) => t + (l.account_id === 'acc:cash' || l.account_id === 'acc:bank' ? l.debit - l.credit : 0), 0)
  );
}

export interface BillingLinkStatus {
  bill_id: string;
  invoice_entry: string;
  receipt_entry: string;
  invoiced: number;
  received: number;
  outstanding: number;
  posted: boolean;
  superseded: number; // invoices reversed by a correction
}

/** What the books currently say about one billing document. */
export function billingLinkStatus(billId: string): BillingLinkStatus {
  const ref = String(billId || '');
  const invoices = ref ? liveEntriesForRef(ref, 'client-invoice') : [];
  const receipts = ref ? liveEntriesForRef(ref, 'client-receipt') : [];
  const invoiced = round2(invoices.reduce((s, e) => s + revenueOf(e), 0));
  const received = round2(receipts.reduce((s, e) => s + cashInOf(e), 0));
  return {
    bill_id: ref,
    invoice_entry: invoices.map((e) => e.id).join(', '),
    receipt_entry: receipts.map((e) => e.id).join(', '),
    invoiced,
    received,
    outstanding: round2(invoiced - received),
    posted: invoices.length > 0,
    superseded: ref ? entriesForRef(ref).filter((e) => e.source === 'billing' && isReversed(e.id)).length : 0,
  };
}

export type BillingSyncAction = 'posted' | 'unchanged' | 'corrected' | 'skipped';

/**
 * Bring the ledger in line with one billing document. Idempotent for an
 * unchanged amount; a changed amount reverses the live invoice and posts the
 * corrected one instead of editing history.
 */
export function syncBillingInvoice(form: {
  billId: string;
  client: string;
  amount: number;
  date: string;
  project?: string;
  retention_pct?: number;
}): { entry: Entry | null; action: BillingSyncAction; reversed: string[] } {
  const billId = String(form.billId || '').trim();
  const amount = round2(Number(form.amount) || 0);
  if (!billId || !(amount > 0)) return { entry: null, action: 'skipped', reversed: [] };

  const live = liveEntriesForRef(billId, 'client-invoice');
  const current = round2(live.reduce((s, e) => s + revenueOf(e), 0));

  // Nothing posted yet, or a single correct invoice → no work.
  if (live.length === 0) {
    const entry = saveEntry(
      'client-invoice',
      { date: form.date, ref: billId, client: form.client, amount, project: form.project || '', retention_pct: form.retention_pct || 0, note: `Invoice ${billId}` },
      { source: 'billing' }
    );
    return { entry, action: 'posted', reversed: [] };
  }
  if (live.length === 1 && Math.abs(current - amount) < 0.005) {
    return { entry: live[0], action: 'unchanged', reversed: [] };
  }

  // Amount changed (or duplicate invoices exist): reverse and re-post.
  const reversed: string[] = [];
  for (const old of live) {
    reverseEntry(old.id, `Bill ${billId} changed from ${current} to ${amount}`, form.date);
    reversed.push(old.id);
  }
  const entry = saveEntry(
    'client-invoice',
    { date: form.date, ref: billId, client: form.client, amount, project: form.project || '', retention_pct: form.retention_pct || 0, note: `Invoice ${billId} (corrected from ${current})` },
    { source: 'billing' }
  );
  return { entry, action: 'corrected', reversed };
}

// ---------------------------------------------------------------------------
// CSV export (S4.6 / A78: local + AD dates, source, account names)
// ---------------------------------------------------------------------------
export function csvHeader(): string[] {
  return ['voucher', 'type', 'ad_date', 'bs_date', 'source', 'account', 'party', 'project', 'debit', 'credit', 'memo', 'note'];
}
export function csvRows(): string[][] {
  const entryMap = new Map(allEntries().map((e) => [e.id, e] as const));
  return allLines().map((l) => {
    const e = entryMap.get(l.entry_id);
    return [
      l.entry_id,
      e?.type || '',
      e?.ad_date || '',
      e ? `${e.bs_y}-${String(e.bs_m).padStart(2, '0')}-${String(e.bs_d).padStart(2, '0')}` : '',
      e?.source || '',
      accountName(l.account_id),
      l.party_id,
      l.project_id,
      String(l.debit),
      String(l.credit),
      l.memo,
      e?.note || '',
    ];
  });
}
export function toCsv(): string {
  return [csvHeader(), ...csvRows()].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
}
export function downloadCsv(fileName: string) {
  const blob = new Blob([toCsv()], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
