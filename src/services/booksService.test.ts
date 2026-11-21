// @vitest-environment jsdom
// Acceptance checks 72 (service half), 73, 74 (billing half), 75, 76, 78.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  recipe,
  saveEntry,
  editEntry,
  linesOf,
  allEntries,
  allLines,
  daybook,
  parties,
  jobCost,
  trialBalance,
  lockPeriod,
  unlockPeriod,
  getAudit,
  toCsv,
  csvHeader,
  nextEntryVoucher,
  expenseAccountId,
  billingInvoiceEntry,
  billingReceiptEntry,
  isEditable,
  jumpTarget,
  feed,
  EXPENSE_CATEGORIES,
  reverseEntry,
  isReversed,
  syncBillingInvoice,
  billingLinkStatus,
  payrollAccrualEntry,
  type EntryType,
} from './booksService';
import { loadTaxSettings, saveTaxSettings, taxBreakdown } from './taxService';

const D = '2025-04-20'; // Baisakh 2082
const P = { year: 2082, month: 1 };

const round2 = (n: number) => Math.round(n * 100) / 100;

beforeEach(() => localStorage.clear());

// One valid form per hopper type (S3.2).
const HOPPER_FORMS: { type: EntryType; form: any }[] = [
  { type: 'supplier-bill', form: { date: D, supplier: 'Sample Steel', project: 'PRJ-001', cost_code: 'Materials', qty: 10, unit: 'ton', rate: 500, due_days: 30, ref: 'PO-1' } },
  { type: 'payment-supplier', form: { date: D, supplier: 'Sample Steel', amount: 4000, method: 'bank', withholding: 100, allocations: [] } },
  { type: 'client-receipt', form: { date: D, client: 'Gyan Constructions', amount: 6000, method: 'bank', retention_release: 500 } },
  { type: 'client-invoice', form: { date: D, client: 'Gyan Constructions', project: 'PRJ-001', amount: 10000, retention_pct: 10 } },
  { type: 'expense-paid', form: { date: D, category: 'Transport', project: 'PRJ-002', amount: 1200, method: 'cash', ref: 'T-1' } },
  { type: 'worker-advance', form: { date: D, worker_id: 'w1', worker_name: 'Rajesh Kumar', amount: 2000, method: 'cash' } },
  { type: 'transfer', form: { date: D, from: 'cash', to: 'bank', amount: 5000 } },
  { type: 'owner-loan-in', form: { date: D, source: 'loan', amount: 20000, method: 'bank' } },
  { type: 'adjustment', form: { date: D, debit_account: expenseAccountId('Transport'), credit_account: 'acc:conversion', amount: 700, note: 'reclass' } },
];

describe('72. posting engine: preview == truth for EVERY hopper type', () => {
  it('recipe() output is identical to the saved lines, entry by entry', () => {
    for (const { type, form } of HOPPER_FORMS) {
      const drafts = recipe(type, form); // ← the preview
      const entry = saveEntry(type, form); // ← the save action
      const lines = linesOf(entry.id);
      expect(lines.length, `${type}: line count`).toBe(drafts.length);
      drafts.forEach((d, i) => {
        expect(lines[i].account_id, `${type}[${i}].account`).toBe(d.account_id);
        expect(lines[i].debit, `${type}[${i}].debit`).toBe(d.debit);
        expect(lines[i].credit, `${type}[${i}].credit`).toBe(d.credit);
        expect(lines[i].party_id, `${type}[${i}].party`).toBe(d.party_id || '');
        expect(lines[i].worker_id, `${type}[${i}].worker`).toBe(d.worker_id || '');
        expect(lines[i].project_id, `${type}[${i}].project`).toBe(d.project_id || '');
      });
      // every entry balances and the trial balance stays green
      const dr = round2(lines.reduce((s, l) => s + l.debit, 0));
      const cr = round2(lines.reduce((s, l) => s + l.credit, 0));
      expect(dr, `${type} balanced`).toBe(cr);
      expect(trialBalance().balanced).toBe(true);
    }
    expect(allEntries()).toHaveLength(HOPPER_FORMS.length);
  });

  it('labour expense categories are blocked with a pointer to the Labour page (S0.3)', () => {
    expect(() => recipe('expense-paid', { date: D, category: 'Labour', amount: 100, method: 'cash' })).toThrow(/Labour page/);
    expect(() => recipe('expense-paid', { date: D, category: 'Salary', amount: 100, method: 'cash' })).toThrow(/payroll|Labour/i);
    expect(() => recipe('supplier-bill', { date: D, supplier: 'X', cost_code: 'Staff Salary Expense', qty: 1, rate: 100 })).toThrow(/Labour|payroll/i);
    // the hopper's category list itself never offers them
    expect(EXPENSE_CATEGORIES).not.toContain('Labour');
    expect(EXPENSE_CATEGORIES).not.toContain('Salary');
  });

  it('voucher series per type per fiscal year (S6.2)', () => {
    expect(nextEntryVoucher('supplier-bill', D, [])).toMatch(/^SB-\d{4}\/\d{2}-001$/);
    saveEntry('supplier-bill', HOPPER_FORMS[0].form);
    expect(nextEntryVoucher('supplier-bill', D)).toMatch(/^SB-\d{4}\/\d{2}-002$/);
    expect(nextEntryVoucher('client-invoice', D)).toMatch(/^CI-\d{4}\/\d{2}-001$/);
  });
});

describe('73. views derive from entry_lines', () => {
  it('Daybook excludes non-cash lines; only cash/bank lines appear, with running balance', () => {
    const cashEntry = saveEntry('expense-paid', HOPPER_FORMS[4].form); // cash out 1200
    const bill = saveEntry('supplier-bill', HOPPER_FORMS[0].form); // no cash leg
    const adj = saveEntry('adjustment', HOPPER_FORMS[8].form); // no cash leg
    const xfer = saveEntry('transfer', HOPPER_FORMS[6].form); // cash → bank

    const cash = daybook('cash', P);
    expect(cash.rows.map((r) => r.voucher).sort()).toEqual([cashEntry.id, xfer.id].sort());
    expect(cash.rows).toHaveLength(2); // expense-paid out + transfer out (cash side)
    expect(cash.rows.every((r) => r.in === 0 || r.out === 0)).toBe(true);
    expect(cash.rows.find((r) => r.voucher === cashEntry.id)!.out).toBe(1200);
    expect(cash.closing).toBe(-6200); // −1200 expense −5000 transfer

    const bank = daybook('bank', P);
    expect(bank.rows).toHaveLength(1); // transfer in only
    expect(bank.closing).toBe(5000);

    // non-cash lines never show up
    const cashIds = new Set(cash.rows.map((r) => r.voucher).concat(bank.rows.map((r) => r.voucher)));
    expect(cashIds.has(bill.id)).toBe(false);
    expect(cashIds.has(adj.id)).toBe(false);
  });

  it('Parties balances equal Σ of that party’s lines (receivable + payable)', () => {
    saveEntry('client-invoice', HOPPER_FORMS[3].form); // AR 9000 + retention 1000
    saveEntry('client-receipt', { date: D, client: 'Gyan Constructions', amount: 6000, method: 'bank', retention_release: 500 });
    saveEntry('supplier-bill', HOPPER_FORMS[0].form); // AP 5000

    const rows = parties(P);
    const client = rows.find((r) => r.party_id === 'Gyan Constructions')!;
    const clientLines = allLines().filter(
      (l) => l.party_id === 'Gyan Constructions' && ['acc:ar', 'acc:retention-ar'].includes(l.account_id)
    );
    const sumDrCr = round2(clientLines.reduce((s, l) => s + l.debit - l.credit, 0));
    expect(client.receivable).toBe(sumDrCr);
    expect(client.receivable).toBe(9000 + 1000 - 6000); // invoice − receipt

    const supplier = rows.find((r) => r.party_id === 'Sample Steel')!;
    const apLines = allLines().filter((l) => l.party_id === 'Sample Steel' && l.account_id === 'acc:ap');
    expect(supplier.payable).toBe(round2(apLines.reduce((s, l) => s + l.credit - l.debit, 0)));
    expect(supplier.payable).toBe(5000);
    // aging puts the open bill in a bucket
    expect(supplier.aging.b0_30 + supplier.aging.b31_60 + supplier.aging.b61).toBeGreaterThan(0);
  });

  it('Job Cost shows accrued ≠ paid wherever credit purchases exist, and settles via bill links', () => {
    const bill = saveEntry('supplier-bill', { date: D, supplier: 'Sample Steel', project: 'PRJ-001', cost_code: 'Materials', qty: 10, unit: 'ton', rate: 500, due_days: 30 });
    let row = jobCost().find((r) => r.project_id === 'PRJ-001')!;
    expect(row.accrued).toBe(5000); // accrued expense line
    expect(row.paid).toBe(0); // nothing paid yet
    expect(row.accrued).not.toBe(row.paid); // 73: accrued ≠ paid
    expect(row.variance).toBe(5000);

    // settle half the bill → paid follows the bill_link
    saveEntry('payment-supplier', { date: D, supplier: 'Sample Steel', amount: 2000, method: 'bank', allocations: [{ entry_id: bill.id, applied: 2000 }] });
    row = jobCost().find((r) => r.project_id === 'PRJ-001')!;
    expect(row.accrued).toBe(5000);
    expect(row.paid).toBe(2000);
    expect(row.variance).toBe(3000);
  });
});

describe('74. billing auto-entries are created once and are read-only with jump links', () => {
  it('invoice + receipt → exactly 2 entries, idempotent, jump to Billing', () => {
    const inv = billingInvoiceEntry({ billId: 'B-2025/06-001', client: 'Gyan Constructions', amount: 9000, date: D });
    expect(inv).not.toBeNull();
    expect(inv!.type).toBe('client-invoice');
    expect(inv!.source).toBe('billing');
    expect(inv!.ref).toBe('B-2025/06-001');
    // idempotent: same billId never posts twice
    expect(billingInvoiceEntry({ billId: 'B-2025/06-001', client: 'Gyan Constructions', amount: 9000, date: D })).toBeNull();

    const rec = billingReceiptEntry({ billId: 'B-2025/06-001', client: 'Gyan Constructions', amount: 9000, date: D });
    expect(rec!.type).toBe('client-receipt');
    expect(billingReceiptEntry({ billId: 'B-2025/06-001', client: 'Gyan Constructions', amount: 9000, date: D })).toBeNull();

    const rows = feed(P).filter((r) => r.entry.ref === 'B-2025/06-001');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.entry.source === 'billing')).toBe(true);
    expect(rows.every((r) => !r.editable)).toBe(true); // read-only in Feed (53)
    expect(jumpTarget(inv!)).toEqual({ page: 'billing', label: 'Open in Billing' });
    expect(() => editEntry(inv!.id, 'client-invoice', { date: D, client: 'x', amount: 1 }, 'nope')).toThrow(/read-only/);
    expect(isEditable(inv!)).toBe(false);
  });
});

describe('75. editing regenerates lines, keeps history, trial balance stays green', () => {
  it('edit replaces the lines atomically and stores the previous version', () => {
    const form = { date: D, category: 'Transport', project: '', amount: 100, method: 'cash' };
    const e = saveEntry('expense-paid', form);
    const before = linesOf(e.id);
    expect(before.reduce((s, l) => s + l.debit, 0)).toBe(100);

    expect(() => editEntry(e.id, 'expense-paid', { ...form, amount: 150 }, '')).toThrow(/reason/i);

    const updated = editEntry(e.id, 'expense-paid', { ...form, amount: 150 }, 'wrong amount');
    expect(updated.edited_history).toHaveLength(1);
    expect(updated.edited_history[0].reason).toBe('wrong amount');
    expect(updated.edited_history[0].lines).toHaveLength(2);
    expect(updated.edited_history[0].lines.reduce((s, l) => s + l.debit, 0)).toBe(100); // previous version kept

    const after = linesOf(e.id);
    expect(after).toHaveLength(2);
    expect(after.reduce((s, l) => s + l.debit, 0)).toBe(150); // regenerated
    expect(trialBalance().balanced).toBe(true); // 75: trial balance stays green
    expect(trialBalance().difference).toBe(0);
  });
});

describe('76. locked periods reject entries and edits; unlock logs the reason', () => {
  it('lock/unlock require reasons, rejection carries a message, audit records both', () => {
    const form = { date: D, category: 'Transport', amount: 100, method: 'cash' };
    const e = saveEntry('expense-paid', form);

    expect(() => lockPeriod(P.year, P.month, '')).toThrow(/reason/i);
    lockPeriod(P.year, P.month, 'Month closed for Baisakh');
    expect(() => saveEntry('expense-paid', form)).toThrow(/locked/i);
    expect(() => saveEntry('expense-paid', { ...form, date: '2025-05-20' })).not.toThrow(); // other period ok
    expect(() => editEntry(e.id, 'expense-paid', { ...form, amount: 50 }, 'bump')).toThrow(/locked/i);

    expect(() => unlockPeriod(P.year, P.month, '')).toThrow(/reason/i);
    unlockPeriod(P.year, P.month, 'Reopened after correction');
    const audit = getAudit();
    expect(audit.some((a) => a.action === 'lock' && a.reason === 'Month closed for Baisakh')).toBe(true);
    expect(audit.some((a) => a.action === 'unlock' && a.reason === 'Reopened after correction')).toBe(true);
    expect(() => editEntry(e.id, 'expense-paid', { ...form, amount: 50 }, 'bump')).not.toThrow();
    expect(() => saveEntry('expense-paid', form)).not.toThrow();
  });
});

describe('79. VAT, TDS, document due dates and reversals', () => {
  it('VAT-only bill: expense is the taxable value and VAT is recoverable', () => {
    const e = saveEntry('supplier-bill', { date: D, supplier: 'Sample Steel', project: 'PRJ-001', cost_code: 'Materials', amount: 10000, vat_rate: 13, due_days: 30 });
    const lines = linesOf(e.id);
    const dr = (acc: string) => lines.filter((l) => l.account_id === acc).reduce((s, l) => s + l.debit, 0);
    const cr = (acc: string) => lines.filter((l) => l.account_id === acc).reduce((s, l) => s + l.credit, 0);
    expect(dr('acc:vat-input')).toBe(1300);
    expect(cr('acc:ap')).toBe(11300);
    expect(dr(expenseAccountId('Materials'))).toBe(10000);
    expect(trialBalance().balanced).toBe(true);
    // job cost and WIP carry the taxable value, never the VAT
    expect(jobCost().find((r) => r.project_id === 'PRJ-001')!.accrued).toBe(10000);
    expect(e.due_date).toBe('2025-05-20');
  });

  it('TDS is withheld from the pre-VAT value and splits the payable', () => {
    const e = saveEntry('supplier-bill', { date: D, supplier: 'Ram Services', project: 'PRJ-001', cost_code: 'Subcontractor', amount: 10000, vat_rate: 13, tds_rate: 1.5 });
    const lines = linesOf(e.id);
    const cr = (acc: string) => lines.filter((l) => l.account_id === acc).reduce((s, l) => s + l.credit, 0);
    expect(cr('acc:tds-payable')).toBe(150);
    expect(cr('acc:ap')).toBe(11150); // 11300 total − 150 TDS
    expect(trialBalance().balanced).toBe(true);
  });

  it('VAT-inclusive amounts split backwards so the document total never drifts', () => {
    const b = taxBreakdown({ gross: 11300, vatRate: 13, vatIncluded: true });
    expect(b.base).toBe(10000);
    expect(b.vat).toBe(1300);
    expect(b.total).toBe(11300);
    const e = saveEntry('supplier-bill', { date: D, supplier: 'Sample Steel', project: 'PRJ-001', cost_code: 'Materials', amount: 11300, vat_rate: 13, vat_included: true });
    const lines = linesOf(e.id);
    expect(lines.filter((l) => l.account_id === 'acc:ap').reduce((s, l) => s + l.credit, 0)).toBe(11300);
    expect(lines.filter((l) => l.account_id === 'acc:vat-input').reduce((s, l) => s + l.debit, 0)).toBe(1300);
  });

  it('invoice: VAT output is payable, retention is taken on the taxable value', () => {
    const e = saveEntry('client-invoice', { date: D, client: 'Gyan Constructions', project: 'PRJ-001', amount: 10000, vat_rate: 13, retention_pct: 10 });
    const lines = linesOf(e.id);
    const cr = (acc: string) => lines.filter((l) => l.account_id === acc).reduce((s, l) => s + l.credit, 0);
    const dr = (acc: string) => lines.filter((l) => l.account_id === acc).reduce((s, l) => s + l.debit, 0);
    expect(cr('acc:income')).toBe(10000);
    expect(cr('acc:vat-output')).toBe(1300);
    expect(dr('acc:retention-ar')).toBe(1000); // 10% of 10000, not of 11300
    expect(dr('acc:ar')).toBe(10300); // 11300 − 1000 retention
    expect(trialBalance().balanced).toBe(true);
  });

  it('no tax rate means no tax line — existing tax-free postings are untouched', () => {
    const e = saveEntry('supplier-bill', { date: D, supplier: 'Sample Steel', project: 'PRJ-001', cost_code: 'Materials', amount: 5000 });
    const ids = linesOf(e.id).map((l) => l.account_id);
    expect(ids).not.toContain('acc:vat-input');
    expect(ids).not.toContain('acc:tds-payable');
    expect(e.due_date).toBeUndefined();
  });

  it('aging uses the stored due date, not the memo string', () => {
    saveEntry('supplier-bill', { date: '2025-01-01', supplier: 'Late Co', project: 'PRJ-001', cost_code: 'Materials', amount: 1000, due_days: 10 });
    const row = parties(P).find((r) => r.party_id === 'Late Co')!;
    expect(row.openBills[0].due).toBe('2025-01-11');
    expect(row.aging.b61).toBe(1000); // long past due at Baisakh 2082 end
  });

  it('reversal posts the exact mirror image, once, with a reason', () => {
    const e = saveEntry('supplier-bill', { date: D, supplier: 'Sample Steel', project: 'PRJ-001', cost_code: 'Materials', amount: 5000, vat_rate: 13 });
    const before = linesOf(e.id).map((l) => ({ a: l.account_id, d: l.debit, c: l.credit }));

    expect(() => reverseEntry(e.id, '')).toThrow(/reason/i);
    const rev = reverseEntry(e.id, 'duplicate bill', '2025-04-25');
    expect(rev.type).toBe('reversal');
    expect(rev.reversal_of).toBe(e.id);
    expect(isReversed(e.id)).toBe(true);

    const after = linesOf(rev.id).map((l) => ({ a: l.account_id, d: l.debit, c: l.credit }));
    expect(after).toEqual(before.map((l) => ({ a: l.a, d: l.c, c: l.d })));
    // the pair cancels: nothing left on the P&L or the balance sheet
    expect(jobCost().find((r) => r.project_id === 'PRJ-001')!.accrued).toBe(0);
    expect(trialBalance().balanced).toBe(true);
    // a reversed document is no longer open for payment
    expect(parties(P).find((r) => r.party_id === 'Sample Steel')?.openBills ?? []).toHaveLength(0);
    // and it cannot be reversed twice
    expect(() => reverseEntry(e.id, 'again')).toThrow(/already reversed/i);
    expect(() => reverseEntry(rev.id, 'nope')).toThrow(/cannot itself be reversed/i);
  });

  it('a billing invoice is reversible (a corrected bill needs it), payroll is not', () => {
    const inv = billingInvoiceEntry({ billId: 'B-2082/01-004', client: 'Gyan Constructions', amount: 1000, date: D })!;
    const rev = reverseEntry(inv.id, 'wrong client invoice');
    expect(rev.reversal_of).toBe(inv.id);
    expect(isReversed(inv.id)).toBe(true);

    const pay = payrollAccrualEntry({
      date: D,
      ref: 'RUN-9',
      workers: [{ worker_id: 'w9', name: 'Worker', amount: 100 }],
      project_splits: [{ project_id: 'PRJ-001', amount: 100 }],
    });
    expect(() => reverseEntry(pay.id, 'wrong')).toThrow(/payroll/i);
  });

  it('tax settings default to 13% VAT and 1.5% TDS and persist', () => {
    expect(loadTaxSettings()).toMatchObject({ vatEnabled: true, vatRate: 13, tdsEnabled: true, tdsRate: 1.5 });
    saveTaxSettings({ vatRate: 0, tdsRate: 0 });
    expect(loadTaxSettings()).toMatchObject({ vatRate: 0, tdsRate: 0 });
  });
});

describe('84. billing and the ledger are linked, never duplicated', () => {
  it('posts one invoice per bill and reports the link', () => {
    const first = syncBillingInvoice({ billId: 'B-1', client: 'Gyan Constructions', amount: 10000, date: D });
    expect(first.action).toBe('posted');
    expect(syncBillingInvoice({ billId: 'B-1', client: 'Gyan Constructions', amount: 10000, date: D }).action).toBe('unchanged');

    const link = billingLinkStatus('B-1');
    expect(link.posted).toBe(true);
    expect(link.invoice_entry).toBe(first.entry!.id);
    expect(link.invoiced).toBe(10000);
    expect(link.outstanding).toBe(10000);
    expect(allEntries().filter((e) => e.ref === 'B-1' && e.type === 'client-invoice')).toHaveLength(1);
  });

  it('a changed amount reverses the old invoice and posts the corrected one', () => {
    syncBillingInvoice({ billId: 'B-2', client: 'Gyan Constructions', amount: 10000, date: D });
    const fixed = syncBillingInvoice({ billId: 'B-2', client: 'Gyan Constructions', amount: 12000, date: D });
    expect(fixed.action).toBe('corrected');
    expect(fixed.reversed).toHaveLength(1);

    const link = billingLinkStatus('B-2');
    expect(link.invoiced).toBe(12000); // net of the reversal
    expect(link.superseded).toBe(1);
    expect(link.invoice_entry).toBe(fixed.entry!.id);
    expect(trialBalance().balanced).toBe(true);
    // the ledger's revenue is the corrected amount, not 22000 of duplicates
    expect(round2(allLines().filter((l) => l.account_id === 'acc:income').reduce((s, l) => s + l.credit - l.debit, 0))).toBe(12000);
  });

  it('a receipt settles the link, and payroll entries stay unreversible', () => {
    syncBillingInvoice({ billId: 'B-3', client: 'Gyan Constructions', amount: 5000, date: D });
    billingReceiptEntry({ billId: 'B-3', client: 'Gyan Constructions', amount: 5000, date: D });
    const link = billingLinkStatus('B-3');
    expect(link.received).toBe(5000);
    expect(link.outstanding).toBe(0);

    const pay = payrollAccrualEntry({
      date: D,
      ref: 'RUN-1',
      workers: [{ worker_id: 'w1', name: 'Rajesh', amount: 100 }],
      project_splits: [{ project_id: 'PRJ-001', amount: 100 }],
    });
    expect(() => reverseEntry(pay.id, 'nope')).toThrow(/payroll/i);
  });

  it('a zero or missing bill never posts', () => {
    expect(syncBillingInvoice({ billId: '', client: 'x', amount: 100, date: D }).action).toBe('skipped');
    expect(syncBillingInvoice({ billId: 'B-4', client: 'x', amount: 0, date: D }).action).toBe('skipped');
    expect(allEntries()).toHaveLength(0);
  });
});

describe('78. CSV export carries local + AD dates, source and account names', () => {
  it('header and rows include ad_date, bs_date, source, account', () => {
    saveEntry('expense-paid', { date: '2025-04-14', category: 'Materials', amount: 500, method: 'bank' });
    const header = csvHeader();
    expect(header).toEqual(expect.arrayContaining(['ad_date', 'bs_date', 'source', 'account']));
    const csv = toCsv();
    expect(csv).toContain('"2025-04-14"'); // AD date
    expect(csv).toContain('"2082-01-01"'); // local calendar (Baisakh 1, 2082)
    expect(csv).toContain('"manual"'); // source
    expect(csv).toContain('"Bank"'); // account name
    expect(csv).toContain('"Materials"'); // expense account name
  });
});
