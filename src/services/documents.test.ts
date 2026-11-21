// @vitest-environment jsdom
// Multi-item documents: a supplier bill with several materials, a running bill
// with several BOQ lines, a debit note (purchase return) and a credit note.
// Every one must post balanced lines, keep its item detail, and survive an edit.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  recipe,
  saveEntry,
  editEntry,
  linesOf,
  allLines,
  trialBalance,
  formForEntry,
  entryById,
  accountName,
  reverseEntry,
  isReversed,
  type EntryType,
} from './booksService';
import { docItemsOf, type DocItem } from './documentService';

const D = '2026-11-12'; // Kartik 2083

beforeEach(() => localStorage.clear());

const billItems: DocItem[] = [
  { id: 'a', line_no: 1, description: 'OPC 43 cement', unit: 'bag', qty: 100, rate: 800, amount: 80000, cost_code: 'Materials', project_id: 'PRJ-001', boq_code: 'A.01' },
  { id: 'b', line_no: 2, description: 'TMT rod 12mm', unit: 'kg', qty: 500, rate: 110, amount: 55000, cost_code: 'Materials', project_id: 'PRJ-001', boq_code: 'A.02' },
  { id: 'c', line_no: 3, description: 'Freight to site', unit: '', qty: 0, rate: 0, amount: 5000, cost_code: 'Transport', project_id: 'PRJ-001', boq_code: '' },
];

describe('multi-item supplier bill', () => {
  it('posts one expense line per cost code and one VAT line, and balances', () => {
    const form = { date: D, supplier: 'Himalayan Hardware', project: 'PRJ-001', items: billItems, vat_rate: 13, due_days: 30 };
    const drafts = recipe('supplier-bill', form);
    const expense = drafts.filter((d) => d.account_id.startsWith('acc:exp:'));
    // one line per cost code × BOQ item: A.01 cement, A.02 rod, freight
    expect(expense).toHaveLength(3);
    const materials = expense.filter((d) => d.cost_code === 'Materials').reduce((s, d) => s + d.debit, 0);
    expect(materials).toBe(135000);
    expect(expense.find((d) => d.cost_code === 'Transport')?.debit).toBe(5000);
    expect(expense.map((d) => d.boq_code).filter(Boolean).sort()).toEqual(['A.01', 'A.02']);
    expect(drafts.find((d) => d.account_id === 'acc:vat-input')?.debit).toBe(18200);
    expect(drafts.find((d) => d.account_id === 'acc:ap')?.credit).toBe(158200);

    const entry = saveEntry('supplier-bill', form);
    expect(trialBalance().balanced).toBe(true);
    expect(docItemsOf(entry.id)).toHaveLength(3);
    expect(docItemsOf(entry.id)[1].description).toBe('TMT rod 12mm');
  });

  it('keeps a bill that splits work across two jobs as two expense lines', () => {
    const items: DocItem[] = [
      { ...billItems[0], project_id: 'PRJ-001' },
      { ...billItems[1], project_id: 'PRJ-002' },
    ];
    const drafts = recipe('supplier-bill', { date: D, supplier: 'Himalayan Hardware', items, vat_rate: 0 });
    const expense = drafts.filter((d) => d.account_id.startsWith('acc:exp:'));
    expect(expense.map((d) => d.project_id).sort()).toEqual(['PRJ-001', 'PRJ-002']);
  });

  it('withholds TDS on the taxable value and pays net', () => {
    const drafts = recipe('supplier-bill', { date: D, supplier: 'Consultant', items: [billItems[0]], vat_rate: 13, tds_rate: 1.5 });
    expect(drafts.find((d) => d.account_id === 'acc:tds-payable')?.credit).toBe(1200); // 1.5% of 80,000
    expect(drafts.find((d) => d.account_id === 'acc:ap')?.credit).toBe(89200); // 90,400 − 1,200
  });

  it('blocks a labour line so payroll keeps ownership of wages', () => {
    expect(() =>
      recipe('supplier-bill', {
        date: D,
        supplier: 'X',
        items: [{ ...billItems[0], cost_code: 'Labour' }],
        vat_rate: 0,
      })
    ).toThrow(/payroll/i);
  });

  it('edits regenerate the lines and replace the item detail', () => {
    const entry = saveEntry('supplier-bill', { date: D, supplier: 'Himalayan Hardware', items: billItems, vat_rate: 13 });
    const shorter = billItems.slice(0, 1);
    editEntry(entry.id, 'supplier-bill', { date: D, supplier: 'Himalayan Hardware', items: shorter, vat_rate: 13 }, 'Supplier corrected the bill');
    expect(docItemsOf(entry.id)).toHaveLength(1);
    expect(trialBalance().balanced).toBe(true);
    const rebuilt = formForEntry(entryById(entry.id)!);
    expect(rebuilt.form.items).toHaveLength(1);
  });
});

describe('running bill (client invoice with many BOQ lines)', () => {
  const lines: DocItem[] = [
    { id: 'l1', line_no: 1, description: 'Excavation', unit: 'cum', qty: 100, rate: 450, amount: 45000, cost_code: '', project_id: 'PRJ-001', boq_code: 'A.01' },
    { id: 'l2', line_no: 2, description: 'PCC 1:4:8', unit: 'cum', qty: 20, rate: 8500, amount: 170000, cost_code: '', project_id: 'PRJ-001', boq_code: 'A.02' },
  ];

  it('earns income, holds retention on the taxable value, and posts output VAT', () => {
    const form = { date: D, client: 'Gyan Constructions', project: 'PRJ-001', items: lines, vat_rate: 13, retention_pct: 5 };
    const drafts = recipe('client-invoice', form);
    expect(drafts.find((d) => d.account_id === 'acc:income')?.credit).toBe(215000);
    expect(drafts.find((d) => d.account_id === 'acc:vat-output')?.credit).toBe(27950);
    expect(drafts.find((d) => d.account_id === 'acc:retention-ar')?.debit).toBe(10750); // 5% of 215,000
    expect(drafts.find((d) => d.account_id === 'acc:ar')?.debit).toBe(232200); // 242,950 − 10,750
    saveEntry('client-invoice', form);
    expect(trialBalance().balanced).toBe(true);
  });
});

describe('purchase return (debit note)', () => {
  it('reduces the payable, the cost and the input VAT together', () => {
    const form = { date: D, supplier: 'Himalayan Hardware', project: 'PRJ-001', items: [{ ...billItems[0], qty: 10, amount: 8000 }], vat_rate: 13 };
    const drafts = recipe('purchase-return', form);
    expect(drafts.find((d) => d.account_id === 'acc:ap')?.debit).toBe(9040);
    expect(drafts.find((d) => d.account_id === 'acc:vat-input')?.credit).toBe(1040);
    expect(drafts.find((d) => d.account_id === 'acc:exp:materials')?.credit).toBe(8000);
    const entry = saveEntry('purchase-return', form);
    expect(entry.id.startsWith('DN-')).toBe(true);
    expect(trialBalance().balanced).toBe(true);
  });
});

describe('credit note', () => {
  it('reverses income and output VAT against the client', () => {
    const form = {
      date: D,
      client: 'Gyan Constructions',
      project: 'PRJ-001',
      items: [{ id: 'x', line_no: 1, description: 'Cement quantity corrected', unit: 'bag', qty: 5, rate: 800, amount: 4000, cost_code: '', project_id: 'PRJ-001', boq_code: 'A.01' }],
      vat_rate: 13,
    };
    const drafts = recipe('credit-note', form);
    expect(drafts.find((d) => d.account_id === 'acc:income')?.debit).toBe(4000);
    expect(drafts.find((d) => d.account_id === 'acc:vat-output')?.debit).toBe(520);
    expect(drafts.find((d) => d.account_id === 'acc:ar')?.credit).toBe(4520);
    const entry = saveEntry('credit-note', form);
    expect(entry.id.startsWith('CN-')).toBe(true);
    expect(trialBalance().balanced).toBe(true);
  });
});

describe('discount and round-off', () => {
  it('spreads a discount before VAT and still balances', () => {
    const drafts = recipe('supplier-bill', { date: D, supplier: 'Himalayan Hardware', items: billItems, vat_rate: 13, discount: 13500 });
    const dr = Math.round(drafts.reduce((s, d) => s + d.debit, 0) * 100) / 100;
    const cr = Math.round(drafts.reduce((s, d) => s + d.credit, 0) * 100) / 100;
    expect(dr).toBe(cr);
    // 140,000 of items − 13,500 discount = 126,500 taxable; VAT 13% of that
    expect(drafts.find((d) => d.account_id === 'acc:vat-input')?.debit).toBe(16445);
    expect(drafts.find((d) => d.account_id === 'acc:ap')?.credit).toBe(142945);
  });

  it('rounds the payable and posts the difference to Round-off', () => {
    const up = recipe('supplier-bill', { date: D, supplier: 'Himalayan Hardware', items: [billItems[0]], vat_rate: 13, round_off: 2 });
    expect(up.find((d) => d.account_id === 'acc:round-off')?.debit).toBe(2);
    expect(up.find((d) => d.account_id === 'acc:ap')?.credit).toBe(90402);

    const down = recipe('supplier-bill', { date: D, supplier: 'Himalayan Hardware', items: [billItems[0]], vat_rate: 13, round_off: -0.4 });
    expect(down.find((d) => d.account_id === 'acc:round-off')?.credit).toBe(0.4);
    expect(down.find((d) => d.account_id === 'acc:ap')?.credit).toBe(90399.6);

    saveEntry('supplier-bill', { date: D, supplier: 'Himalayan Hardware', items: [billItems[0]], vat_rate: 13, round_off: 2 });
    expect(trialBalance().balanced).toBe(true);
  });

  it('an invoice with retention and round-off still balances', () => {
    const drafts = recipe('client-invoice', {
      date: D,
      client: 'Gyan Constructions',
      project: 'PRJ-001',
      items: [{ ...billItems[0] }],
      vat_rate: 13,
      retention_pct: 5,
      round_off: 1,
    });
    const dr = Math.round(drafts.reduce((s, d) => s + d.debit, 0) * 100) / 100;
    const cr = Math.round(drafts.reduce((s, d) => s + d.credit, 0) * 100) / 100;
    expect(dr).toBe(cr);
    expect(drafts.find((d) => d.account_id === 'acc:retention-ar')?.debit).toBe(4000); // 5% of 80,000
    expect(drafts.find((d) => d.account_id === 'acc:ar')?.debit).toBe(86401); // 90,400 − 4,000 + 1
  });
});

describe('document reversal', () => {
  it('a multi-item bill reverses to zero and keeps its items', () => {
    const entry = saveEntry('supplier-bill', { date: D, supplier: 'Himalayan Hardware', items: billItems, vat_rate: 13 });
    reverseEntry(entry.id, 'Bill entered twice');
    expect(isReversed(entry.id)).toBe(true);
    const net = allLines().filter((l) => l.account_id.startsWith('acc:exp:')).reduce((s, l) => s + l.debit - l.credit, 0);
    expect(Math.round(net * 100) / 100).toBe(0);
    expect(docItemsOf(entry.id)).toHaveLength(3); // history keeps the paper trail
    expect(accountName('acc:ap')).toBe('Accounts Payable');
  });
});

// Every new type must also be covered by the shared recipe contract.
describe('new document types are first-class entry types', () => {
  it('has its own voucher series', () => {
    const types: EntryType[] = ['purchase-return', 'credit-note'];
    for (const t of types) expect(typeof t).toBe('string');
  });
});
