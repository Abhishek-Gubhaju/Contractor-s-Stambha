// @vitest-environment jsdom
// Inventory sub-ledger: stock is an asset until issued, valued at a moving
// average, and reverses quantity and ledger together.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  upsertStockItem,
  postStockMovement,
  stockOf,
  stockOnHand,
  inventoryValue,
  inventoryReconciliation,
  reverseStockEntry,
  movementsForItem,
  issuesByProject,
  removeStockItem,
} from './stockService';
import { jobCost, trialBalance, linesOf, allLines, reverseEntry, type Entry } from './booksService';

const D = '2025-04-20'; // Baisakh 2082

beforeEach(() => {
  localStorage.clear();
  upsertStockItem({ name: 'Cement OPC 43', unit: 'bag', costCode: 'Materials' });
});

const cement = () => stockOnHand()[0].item.id;

const sum = (entry: Entry, account: string, side: 'debit' | 'credit') =>
  linesOf(entry.id).filter((l) => l.account_id === account).reduce((s, l) => s + l[side], 0);

describe('80. materials are an asset until they are issued', () => {
  it('a cash purchase puts cost in Inventory and nothing on the job', () => {
    const { entry } = postStockMovement({ kind: 'receipt', item_id: cement(), date: D, qty: 100, rate: 50, method: 'cash', source: 'cash' });

    expect(sum(entry, 'acc:inventory', 'debit')).toBe(5000);
    expect(sum(entry, 'acc:cash', 'credit')).toBe(5000);
    expect(jobCost().find((r) => r.project_id === 'PRJ-001')).toBeUndefined(); // not a job cost yet
    expect(stockOf(cement())).toEqual({ qty: 100, value: 5000, avg: 50 });
    expect(inventoryValue()).toBe(5000);
    expect(trialBalance().balanced).toBe(true);
  });

  it('issuing to a job moves the cost onto that job at the average', () => {
    postStockMovement({ kind: 'receipt', item_id: cement(), date: D, qty: 100, rate: 50, method: 'cash' });
    const { entry } = postStockMovement({ kind: 'issue', item_id: cement(), date: D, qty: 40, project_id: 'PRJ-001', cost_code: 'Materials' });

    expect(sum(entry, 'acc:inventory', 'credit')).toBe(2000);
    expect(sum(entry, 'acc:exp:materials', 'debit')).toBe(2000);
    expect(jobCost().find((r) => r.project_id === 'PRJ-001')!.accrued).toBe(2000);
    expect(stockOf(cement())).toEqual({ qty: 60, value: 3000, avg: 50 });
    expect(issuesByProject()[0]).toMatchObject({ project_id: 'PRJ-001', qty: 40, value: 2000 });
    expect(inventoryReconciliation().balanced).toBe(true);
  });

  it('cannot issue more than is on hand, and an issue must name a job', () => {
    postStockMovement({ kind: 'receipt', item_id: cement(), date: D, qty: 10, rate: 50, method: 'cash' });
    expect(() => postStockMovement({ kind: 'issue', item_id: cement(), date: D, qty: 11, project_id: 'PRJ-001' })).toThrow(/on hand/i);
    expect(() => postStockMovement({ kind: 'issue', item_id: cement(), date: D, qty: 5 })).toThrow(/job/i);
    expect(movementsForItem(cement())).toHaveLength(1); // nothing was posted
  });

  it('values stock at the weighted moving average across receipts', () => {
    postStockMovement({ kind: 'receipt', item_id: cement(), date: D, qty: 100, rate: 50, method: 'cash' });
    postStockMovement({ kind: 'receipt', item_id: cement(), date: '2025-04-22', qty: 50, rate: 80, method: 'cash' });
    // 100×50 + 50×80 = 9000 over 150 units
    expect(stockOf(cement())).toMatchObject({ qty: 150, value: 9000, avg: 60 });

    const { entry } = postStockMovement({ kind: 'issue', item_id: cement(), date: '2025-04-23', qty: 25, project_id: 'PRJ-001' });
    expect(sum(entry, 'acc:inventory', 'credit')).toBe(1500); // 25 × 60
    expect(stockOf(cement())).toMatchObject({ qty: 125, value: 7500, avg: 60 });
  });

  it('a count loss writes the stock off instead of hiding it', () => {
    postStockMovement({ kind: 'receipt', item_id: cement(), date: D, qty: 100, rate: 50, method: 'cash' });
    const { entry } = postStockMovement({ kind: 'adjust', item_id: cement(), date: D, qty: -5, note: 'broken bags' });
    expect(sum(entry, 'acc:inventory', 'credit')).toBe(250);
    expect(sum(entry, 'acc:stock-adjust', 'debit')).toBe(250);
    expect(stockOf(cement()).qty).toBe(95);
    expect(trialBalance().balanced).toBe(true);
  });

  it('a credit purchase carries VAT separately and posts to the supplier', () => {
    const { entry } = postStockMovement({
      kind: 'receipt', item_id: cement(), date: D, qty: 10, rate: 100,
      source: 'supplier', supplier: 'Sample Steel', vat_rate: 13,
    });
    expect(sum(entry, 'acc:inventory', 'debit')).toBe(1000); // asset is tax-exclusive
    expect(sum(entry, 'acc:vat-input', 'debit')).toBe(130);
    expect(sum(entry, 'acc:ap', 'credit')).toBe(1130);
    expect(stockOf(cement()).value).toBe(1000);
  });
});

describe('81. stock entries reverse quantity and ledger together', () => {
  it('reversing a receipt removes the stock and the payable', () => {
    const { entry } = postStockMovement({ kind: 'receipt', item_id: cement(), date: D, qty: 10, rate: 100, source: 'supplier', supplier: 'Sample Steel' });
    const rev = reverseStockEntry(entry.id, 'goods returned');
    expect(stockOf(cement()).qty).toBe(0);
    expect(stockOf(cement()).value).toBe(0);
    expect(movementsForItem(cement())).toHaveLength(2);
    expect(sum(rev, 'acc:inventory', 'credit')).toBe(1000);
    expect(inventoryReconciliation().balanced).toBe(true);
    expect(trialBalance().balanced).toBe(true);
  });

  it('the ledger refuses a plain reversal of a stock entry', () => {
    const { entry } = postStockMovement({ kind: 'receipt', item_id: cement(), date: D, qty: 1, rate: 100, method: 'cash' });
    expect(() => reverseEntry(entry.id, 'wrong')).toThrow(/Inventory page/i);
  });

  it('a reversed issue stops counting as job consumption', () => {
    postStockMovement({ kind: 'receipt', item_id: cement(), date: D, qty: 10, rate: 100, method: 'cash' });
    const { entry } = postStockMovement({
      kind: 'issue',
      item_id: cement(),
      date: D,
      qty: 4,
      project_id: 'PRJ-001',
      cost_code: 'Materials',
    });
    expect(issuesByProject().find((r) => r.project_id === 'PRJ-001')).toMatchObject({ qty: 4, value: 400 });

    reverseStockEntry(entry.id, 'wrong site');
    expect(issuesByProject().find((r) => r.project_id === 'PRJ-001')).toMatchObject({ qty: 0, value: 0 });
    expect(trialBalance().balanced).toBe(true);
  });
});

describe('82. item master guards', () => {
  it('an item with movements cannot be deleted', () => {
    postStockMovement({ kind: 'receipt', item_id: cement(), date: D, qty: 1, rate: 100, method: 'cash' });
    expect(() => removeStockItem(cement())).toThrow(/cannot be deleted/i);
  });

  it('reorder shortfall shows once stock falls below the level', () => {
    upsertStockItem({ name: 'Binding Wire', unit: 'kg', costCode: 'Materials', reorderLevel: 20 });
    const wire = stockOnHand().find((r) => r.item.name === 'Binding Wire')!;
    expect(wire.shortfall).toBe(20);
    postStockMovement({ kind: 'receipt', item_id: wire.item.id, date: D, qty: 25, rate: 90, method: 'cash' });
    expect(stockOnHand().find((r) => r.item.name === 'Binding Wire')!.shortfall).toBe(0);
  });
});

describe('83. issued stock is a real cost line on the job', () => {
  it('the issue debit carries project, cost code and BOQ code', () => {
    postStockMovement({ kind: 'receipt', item_id: cement(), date: D, qty: 10, rate: 100, method: 'cash' });
    const { entry } = postStockMovement({ kind: 'issue', item_id: cement(), date: D, qty: 2, project_id: 'PRJ-001', cost_code: 'Materials', boq_code: 'A.01' });
    const expense = linesOf(entry.id).find((l) => l.debit > 0)!;
    expect(expense.project_id).toBe('PRJ-001');
    expect(expense.cost_code).toBe('Materials');
    expect(expense.boq_code).toBe('A.01');
    expect(allLines().filter((l) => l.account_id === 'acc:inventory')).toHaveLength(2);
  });
});
