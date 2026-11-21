// @vitest-environment jsdom
// Running-bill depth (advance recovery, previous bills), party auto-fill,
// part-payment allocation against a multi-item bill, and the registers.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveEntry,
  recipe,
  linesOf,
  loadBillLinks,
  billedToDate,
  clientAdvanceBalance,
  entryById,
  trialBalance,
  reverseEntry,
  type Period,
} from './booksService';
import { upsertParty, ensureParty } from './partyService';
import type { EntryType } from './booksService';
import { buildRows } from '../pages/ledger/Registers';
import type { DocItem } from './documentService';

const D = '2026-11-12';

const item = (patch: Partial<DocItem> = {}): DocItem => ({
  id: Math.random().toString(36).slice(2),
  line_no: 1,
  description: 'Excavation',
  unit: 'cum',
  qty: 100,
  rate: 450,
  amount: 45000,
  cost_code: '',
  project_id: 'PRJ-001',
  boq_code: 'A.01',
  ...patch,
});

beforeEach(() => localStorage.clear());

describe('party master feeds documents', () => {
  it('fills PAN, address and credit days from the master', () => {
    upsertParty({ name: 'Gyan Constructions', type: 'client', pan: '601234567', address: 'Kathmandu', creditDays: 15 });
    const entry = saveEntry('client-invoice', {
      date: D,
      client: 'Gyan Constructions',
      project: 'PRJ-001',
      items: [item()],
      vat_rate: 0,
    });
    expect(entry.party_pan).toBe('601234567');
    expect(entry.party_address).toBe('Kathmandu');
    expect(entry.due_date).toBe('2026-11-27'); // +15 credit days
  });

  it('adopts an unknown name instead of rejecting the posting', () => {
    saveEntry('supplier-bill', { date: D, supplier: 'New Hardware', items: [item({ cost_code: 'Materials' })], vat_rate: 0 });
    expect(ensureParty('New Hardware', 'supplier')?.name).toBe('New Hardware');
  });
});

describe('running bill: advance and previous bills', () => {
  it('recovers only the advance actually held, and reduces the receivable', () => {
    const adv = saveEntry('client-advance', { date: D, client: 'Gyan Constructions', project: 'PRJ-001', amount: 50000, method: 'bank' });
    expect(adv.id.startsWith('CA-')).toBe(true);
    expect(clientAdvanceBalance('Gyan Constructions')).toBe(50000);

    const bill = saveEntry('client-invoice', {
      date: D,
      client: 'Gyan Constructions',
      project: 'PRJ-001',
      items: [item({ amount: 100000 })],
      vat_rate: 0,
      advance_recovery: 40000,
    });
    const lines = linesOf(bill.id);
    expect(lines.find((l) => l.account_id === 'acc:ar')?.debit).toBe(60000); // 100,000 − 40,000 recovered
    expect(lines.find((l) => l.account_id === 'acc:advance-client')?.debit).toBe(40000);
    expect(clientAdvanceBalance('Gyan Constructions')).toBe(10000);
    expect(trialBalance().balanced).toBe(true);
  });

  it('refuses to recover more than the client has advanced', () => {
    saveEntry('client-advance', { date: D, client: 'A', amount: 1000, method: 'cash' });
    expect(() =>
      recipe('client-invoice', { date: D, client: 'A', project: 'PRJ-001', items: [item({ amount: 5000 })], vat_rate: 0, advance_recovery: 2000 })
    ).toThrow(/advance/i);
  });

  it('reports revenue billed to date per job', () => {
    saveEntry('client-invoice', { date: D, client: 'A', project: 'PRJ-001', items: [item({ amount: 30000 })], vat_rate: 0 });
    saveEntry('client-invoice', { date: D, client: 'A', project: 'PRJ-001', items: [item({ amount: 20000 })], vat_rate: 0 });
    saveEntry('client-invoice', { date: D, client: 'A', project: 'PRJ-002', items: [item({ amount: 9000, project_id: 'PRJ-002' })], vat_rate: 0 });
    expect(billedToDate('PRJ-001')).toBe(50000);
    expect(billedToDate('PRJ-002')).toBe(9000);
  });
});

describe('part-payment against a multi-item bill', () => {
  it('links the payment to the bill payable line, not to line #1', () => {
    const bill = saveEntry('supplier-bill', {
      date: D,
      supplier: 'Himalayan Hardware',
      project: 'PRJ-001',
      items: [item({ cost_code: 'Materials', amount: 10000 }), item({ cost_code: 'Transport', amount: 2000 })],
      vat_rate: 13,
    });
    const apLine = linesOf(bill.id).find((l) => l.account_id === 'acc:ap')!;
    expect(apLine.id).not.toBe(`${bill.id}#1`);

    const pay = saveEntry('payment-supplier', {
      date: D,
      supplier: 'Himalayan Hardware',
      amount: 6000,
      method: 'bank',
      allocations: [{ entry_id: bill.id, applied: 6000 }],
    });
    const link = loadBillLinks().find((l) => l.payment_line_id.startsWith(`${pay.id}#`));
    expect(link?.bill_line_id).toBe(apLine.id);
    expect(link?.applied_amount).toBe(6000);
    // a part payment leaves the rest open as payable
    expect(entryById(bill.id)).toBeTruthy();
    expect(trialBalance().balanced).toBe(true);
  });

  it('keeps the unallocated part as an advance to the supplier', () => {
    const pay = saveEntry('payment-supplier', { date: D, supplier: 'Himalayan Hardware', amount: 5000, method: 'cash', allocations: [] });
    expect(linesOf(pay.id).find((l) => l.account_id === 'acc:advance-supplier')?.debit).toBe(5000);
  });
});

describe('opening balances', () => {
  it('opens cash against equity and keeps the balance', () => {
    const entry = saveEntry('opening-balance', { date: D, account: 'cash', amount: 250000 });
    expect(entry.id.startsWith('OB-')).toBe(true);
    const lines = linesOf(entry.id);
    expect(lines.find((l) => l.account_id === 'acc:cash')?.debit).toBe(250000);
    expect(lines.find((l) => l.account_id === 'acc:opening')?.credit).toBe(250000);
    expect(trialBalance().balanced).toBe(true);
  });

  it('opens a client receivable and a supplier payable', () => {
    const ar = saveEntry('opening-balance', { date: D, account: 'receivable', party: 'Gyan Constructions', amount: 12000 });
    expect(linesOf(ar.id).find((l) => l.account_id === 'acc:ar')?.debit).toBe(12000);
    const ap = saveEntry('opening-balance', { date: D, account: 'payable', party: 'Himalayan Hardware', amount: 8000 });
    expect(linesOf(ap.id).find((l) => l.account_id === 'acc:ap')?.credit).toBe(8000);
    expect(trialBalance().balanced).toBe(true);
  });

  it('needs a party for a receivable or payable', () => {
    expect(() => recipe('opening-balance', { date: D, account: 'receivable', amount: 100 })).toThrow(/party/i);
  });
});

describe('registers', () => {
  const period: Period = { year: 2083, month: 7 };

  it('lists purchases with PAN, taxable value and VAT', () => {
    upsertParty({ name: 'Himalayan Hardware', type: 'supplier', pan: '601234567' });
    saveEntry('supplier-bill', {
      date: D,
      supplier: 'Himalayan Hardware',
      ref: 'HH-9',
      project: 'PRJ-001',
      items: [item({ cost_code: 'Materials', amount: 10000 })],
      vat_rate: 13,
    });
    const rows = buildRows('purchase', period);
    expect(rows).toHaveLength(1);
    expect(rows[0].party).toBe('Himalayan Hardware');
    expect(rows[0].pan).toBe('601234567');
    expect(rows[0].taxable).toBe(10000);
    expect(rows[0].vat).toBe(1300);
    expect(rows[0].total).toBe(11300);
  });

  it('puts invoices in the sales register and leaves other periods out', () => {
    saveEntry('client-invoice', { date: D, client: 'Gyan Constructions', project: 'PRJ-001', items: [item({ amount: 40000 })], vat_rate: 13 });
    saveEntry('client-invoice', { date: '2026-09-01', client: 'Gyan Constructions', project: 'PRJ-001', items: [item({ amount: 1000 })], vat_rate: 13 });
    const rows = buildRows('sales', period);
    expect(rows).toHaveLength(1);
    expect(rows[0].taxable).toBe(40000);
    expect(rows[0].vat).toBe(5200);
    expect(buildRows('purchase', period)).toHaveLength(0);
  });

  it('marks a reversed document so it is not counted', () => {
    const bill = saveEntry('supplier-bill', { date: D, supplier: 'X', items: [item({ cost_code: 'Materials', amount: 1000 })], vat_rate: 0 });
    reverseEntry(bill.id, 'wrong supplier');
    const rows = buildRows('purchase', period);
    expect(rows.find((r) => r.voucher === bill.id)?.reversed).toBe(true);
  });
});
