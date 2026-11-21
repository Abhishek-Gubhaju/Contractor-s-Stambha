// @vitest-environment jsdom
// “Paid now” — a supplier bill and its Payment to Supplier posted as ONE atomic
// action. The books must read exactly as if the two-step flow had been used.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  recipe,
  saveEntry,
  saveSupplierBill,
  editEntry,
  reverseEntry,
  isReversed,
  supplierBillPayable,
  linesOf,
  allEntries,
  allLines,
  loadBillLinks,
  entryById,
  parties,
  trialBalance,
} from './booksService';
import type { DocItem } from './documentService';

const D = '2026-11-12';
const P = { year: 2083, month: 7 };
const SUPPLIER = 'Himalayan Hardware';

const item = (patch: Partial<DocItem> = {}): DocItem => ({
  id: Math.random().toString(36).slice(2),
  line_no: 1,
  description: 'Cement',
  unit: 'bag',
  qty: 100,
  rate: 100,
  amount: 10000,
  cost_code: 'Materials',
  project_id: 'PRJ-001',
  boq_code: '',
  ...patch,
});

const billForm = (patch: Record<string, any> = {}) => ({
  date: D,
  supplier: SUPPLIER,
  project: 'PRJ-001',
  items: [item({ amount: 10000 })],
  vat_rate: 13,
  round_off: 0.4,
  ref: 'INV-9',
  paid_now: true,
  pay_method: 'bank',
  ...patch,
});

const cashOut = (entryId: string, account: 'acc:cash' | 'acc:bank') =>
  linesOf(entryId).find((l) => l.account_id === account)?.credit;

const apDebit = (entryId: string) => linesOf(entryId).find((l) => l.account_id === 'acc:ap')?.debit;
const apCredit = (entryId: string) => linesOf(entryId).find((l) => l.account_id === 'acc:ap')?.credit;

beforeEach(() => localStorage.clear());

describe('paid now: two entries, one action', () => {
  it('posts a balanced bill + payment pair linked both ways', () => {
    const { bill, payment } = saveSupplierBill(billForm());

    expect(payment).toBeTruthy();
    expect(allEntries()).toHaveLength(2);
    expect(payment!.type).toBe('payment-supplier');
    expect(bill.type).toBe('supplier-bill');

    // Two vouchers, two journals — never merged.
    expect(bill.id).not.toBe(payment!.id);
    expect(bill.auto_payment_id).toBe(payment!.id);
    expect(payment!.auto_bill_id).toBe(bill.id);

    // Bill leg is the ordinary recipe: expense + VAT + payable + round-off.
    expect(linesOf(bill.id).find((l) => l.account_id === 'acc:vat-input')?.debit).toBe(1300);
    expect(apCredit(bill.id)).toBe(11300.4);

    // Payment leg moves the full payable out of the bank, all of it to the bill.
    expect(apDebit(payment!.id)).toBe(11300.4);
    expect(cashOut(payment!.id, 'acc:bank')).toBe(11300.4);
    expect(linesOf(payment!.id).some((l) => l.account_id === 'acc:advance-supplier')).toBe(false);

    const links = loadBillLinks();
    expect(links).toHaveLength(1);
    expect(links[0].bill_line_id).toBe(linesOf(bill.id).find((l) => l.account_id === 'acc:ap')!.id);
    expect(links[0].applied_amount).toBe(11300.4);

    // Same date and reference as the bill.
    expect(payment!.ad_date).toBe(bill.ad_date);
    expect(payment!.ref).toBe(bill.ref);

    // Supplier balance unchanged net, bill no longer open, books balanced.
    const row = parties(P).find((r) => r.party_id === SUPPLIER)!;
    expect(row.payable).toBe(0);
    expect(row.openBills).toHaveLength(0);
    expect(trialBalance().balanced).toBe(true);
  });

  it('defaults to cash and honours a chosen payment date', () => {
    const { payment } = saveSupplierBill(billForm({ pay_method: undefined, pay_date: '2026-11-20' }));
    expect(cashOut(payment!.id, 'acc:cash')).toBe(11300.4);
    expect(payment!.ad_date).toBe('2026-11-20');
  });

  it('unchecked behaves exactly like the plain bill save', () => {
    const { bill, payment } = saveSupplierBill(billForm({ paid_now: false }));
    expect(payment).toBeNull();
    expect(allEntries()).toHaveLength(1);
    expect(bill.auto_payment_id).toBeUndefined();
    expect(allLines().some((l) => l.account_id === 'acc:cash' || l.account_id === 'acc:bank')).toBe(false);

    const expected = recipe('supplier-bill', billForm({ paid_now: false }));
    expect(linesOf(bill.id).map((l) => ({ a: l.account_id, d: l.debit, c: l.credit }))).toEqual(
      expected.map((d) => ({ a: d.account_id, d: d.debit, c: d.credit }))
    );
    expect(parties(P).find((r) => r.party_id === SUPPLIER)!.openBills).toHaveLength(1);
  });

  it('computes the payment from the post-VAT, post-discount, post-round-off payable', () => {
    const form = { date: D, supplier: SUPPLIER, project: 'PRJ-001', items: [item({ amount: 10000 })], vat_rate: 13, discount: 1000, round_off: 1.6 };
    // taxable 9,000 · VAT 1,170 · round-off +1.60
    expect(supplierBillPayable(recipe('supplier-bill', { ...form, paid_now: true }))).toBe(10171.6);

    const { bill, payment } = saveSupplierBill({ ...form, paid_now: true });
    expect(apCredit(bill.id)).toBe(10171.6);
    expect(apDebit(payment!.id)).toBe(10171.6);
    expect(loadBillLinks()[0].applied_amount).toBe(10171.6);
    expect(parties(P).find((r) => r.party_id === SUPPLIER)!.openBills).toHaveLength(0);
  });
});

describe('paid now: TDS is gated, never split', () => {
  it('refuses the checkbox path when TDS is withheld', () => {
    expect(() => saveSupplierBill(billForm({ tds_rate: 1.5 }))).toThrow(/TDS/);
    // Nothing was written: no half transaction.
    expect(allEntries()).toHaveLength(0);
    expect(allLines()).toHaveLength(0);
  });

  it('leaves the TDS bill and the standalone payment flow untouched', () => {
    const { payment } = saveSupplierBill(billForm({ tds_rate: 1.5, paid_now: false }));
    expect(payment).toBeNull();
    expect(allLines().find((l) => l.account_id === 'acc:tds-payable')?.credit).toBe(150);
    expect(trialBalance().balanced).toBe(true);
  });
});

describe('paid now: atomicity', () => {
  it('rolls both legs back when the payment cannot be written', () => {
    const original = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key.split('::')[0] === 'contractoros_entries' && String(value).includes('"payment-supplier"')) throw new Error('disk full');
      return original.call(this, key, value);
    });

    expect(() => saveSupplierBill(billForm())).toThrow(/disk full/);
    spy.mockRestore();

    expect(allEntries()).toHaveLength(0);
    expect(allLines()).toHaveLength(0);
    expect(loadBillLinks()).toHaveLength(0);
  });
});

describe('paid now: editing the bill keeps the payment in step', () => {
  it('rewrites amount, date, reference and allocation together', () => {
    const { bill, payment } = saveSupplierBill(billForm({ round_off: 0, pay_method: 'cash' }));
    const payId = payment!.id;
    const oldApLine = linesOf(bill.id).find((l) => l.account_id === 'acc:ap')!.id;

    const updated = editEntry(
      bill.id,
      'supplier-bill',
      billForm({ round_off: 0, ref: 'INV-9A', items: [item({ amount: 12000, cost_code: 'Materials' }), item({ amount: 2000, cost_code: 'Transport' })] }),
      'price corrected'
    );

    const pay = entryById(payId)!;
    expect(pay.ad_date).toBe(updated.ad_date);
    expect(pay.ref).toBe('INV-9A');
    expect(apDebit(payId)).toBe(15820); // (12,000 + 2,000) + 13%
    expect(cashOut(payId, 'acc:cash')).toBe(15820); // method preserved
    // The edit added a line, so the bill's payable/new control line moved.
    const newApLine = linesOf(bill.id).find((l) => l.account_id === 'acc:ap')!.id;
    expect(newApLine).not.toBe(oldApLine);

    const links = loadBillLinks().filter((l) => l.payment_line_id.startsWith(`${payId}#`));
    expect(links).toHaveLength(1);
    expect(links[0].bill_line_id).toBe(newApLine);
    expect(links[0].applied_amount).toBe(15820);

    const row = parties(P).find((r) => r.party_id === SUPPLIER)!;
    expect(row.payable).toBe(0);
    expect(row.openBills).toHaveLength(0);
    expect(trialBalance().balanced).toBe(true);
  });

  it('blocks adding TDS to a paid bill instead of leaving a stale payment', () => {
    const { bill, payment } = saveSupplierBill(billForm());
    const before = linesOf(bill.id).map((l) => ({ a: l.account_id, d: l.debit, c: l.credit }));

    expect(() => editEntry(bill.id, 'supplier-bill', billForm({ tds_rate: 1.5 }), 'add tds')).toThrow(/TDS/);

    expect(linesOf(bill.id).map((l) => ({ a: l.account_id, d: l.debit, c: l.credit }))).toEqual(before);
    expect(apDebit(payment!.id)).toBe(11300.4);
    expect(trialBalance().balanced).toBe(true);
  });
});

describe('paid now: reversal moves the pair', () => {
  it('reverses the auto-payment with its bill, and refuses the payment alone', () => {
    const { bill, payment } = saveSupplierBill(billForm());

    expect(() => reverseEntry(payment!.id, 'wrong')).toThrow(/reverse that bill/i);

    const rev = reverseEntry(bill.id, 'duplicate bill');
    expect(rev.reversal_of).toBe(bill.id);
    expect(isReversed(bill.id)).toBe(true);
    expect(isReversed(payment!.id)).toBe(true);

    const row = parties(P).find((r) => r.party_id === SUPPLIER)!;
    expect(row.payable).toBe(0);
    expect(row.openBills).toHaveLength(0);
    expect(trialBalance().balanced).toBe(true);
  });
});

describe('paid now: plain saves are untouched', () => {
  it('saveEntry still posts a single entry for a credit bill', () => {
    const bill = saveEntry('supplier-bill', billForm({ paid_now: false }));
    expect(allEntries()).toHaveLength(1);
    expect(bill.auto_payment_id).toBeUndefined();
  });
});
