// @vitest-environment jsdom
// Statements are derived: P&L, balance sheet and project P&L must tie to the
// posted ledger, keep VAT off the P&L, treat retention as an asset, and net
// reversals out rather than counting both sides.
import { describe, it, expect, beforeEach } from 'vitest';
import { saveEntry, reverseEntry, trialBalance } from './booksService';
import { statementWindow, profitAndLoss, balanceSheet, projectPnl } from './statementsService';

const D = '2025-04-20'; // Baisakh 2082
const PRIOR = '2025-03-20'; // Chaitra 2081
const W = statementWindow(2082, 1, 'month');

const round2 = (n: number) => Math.round(n * 100) / 100;

beforeEach(() => localStorage.clear());

function seedJob() {
  saveEntry('client-invoice', { date: D, client: 'Gyan Constructions', project: 'PRJ-001', amount: 10000 });
  saveEntry('supplier-bill', { date: D, supplier: 'Sample Steel', project: 'PRJ-001', cost_code: 'Materials', amount: 6000 });
  saveEntry('expense-paid', { date: D, category: 'Office', amount: 1000, method: 'cash' }); // no job → overhead
}

describe('85. statement window', () => {
  it('covers one B.S. month, with the month before as the comparative', () => {
    expect(W.from).toBe('2025-04-14');
    expect(W.to).toBe('2025-05-14');
    expect(W.priorTo).toBe('2025-04-13'); // day before the period starts
    expect(W.priorFrom < W.priorTo).toBe(true);
    expect(W.label).toBe('Baisakh 2082');
  });

  it('fiscal year to date starts at Baisakh and compares with the same span last year', () => {
    const fy = statementWindow(2082, 3, 'fytd');
    expect(fy.months).toBe(3);
    expect(fy.from).toBe(W.from); // fiscal year starts in Baisakh
    expect(fy.label).toContain('→');
    expect(fy.priorFrom < fy.priorTo).toBe(true);
  });
});

describe('86. profit & loss', () => {
  it('separates direct job cost from overhead and reports both margins', () => {
    seedJob();
    const p = profitAndLoss(W);

    expect(p.revenueTotal).toBe(10000);
    expect(p.directCostTotal).toBe(6000);
    expect(p.grossProfit).toBe(4000);
    expect(p.grossMargin).toBe(40);
    expect(p.overheadTotal).toBe(1000);
    expect(p.netProfit).toBe(3000);
    expect(p.netMargin).toBe(30);

    // direct cost is grouped by cost-code kind, not by account name
    expect(p.directCost.map((r) => r.key)).toEqual(['material']);
    expect(p.directCost[0].label).toBe('Materials');
    // overhead is grouped by the account it hit
    expect(p.overheads.map((r) => r.label)).toEqual(['Office']);
  });

  it('leaves VAT out of revenue and cost, and keeps retention out of revenue', () => {
    saveEntry('client-invoice', { date: D, client: 'Gyan Constructions', project: 'PRJ-001', amount: 10000, vat_rate: 13, retention_pct: 10 });
    const p = profitAndLoss(W);
    expect(p.revenueTotal).toBe(10000); // not 11300
    expect(p.netProfit).toBe(10000);
  });

  it('reads the comparative window separately and ignores other months', () => {
    saveEntry('expense-paid', { date: PRIOR, category: 'Office', amount: 400, method: 'cash' });
    saveEntry('expense-paid', { date: D, category: 'Office', amount: 1000, method: 'cash' });
    const p = profitAndLoss(W);
    expect(p.overheadTotal).toBe(1000);
    expect(p.overheadPrior).toBe(400); // Chaitra 2081
    expect(p.overheads[0].prior).toBe(400);
  });

  it('nets a reversal out of both sides', () => {
    const bill = saveEntry('supplier-bill', { date: D, supplier: 'Sample Steel', project: 'PRJ-001', cost_code: 'Materials', amount: 6000 });
    reverseEntry(bill.id, 'duplicate', D);
    const p = profitAndLoss(W);
    expect(p.directCostTotal).toBe(0);
    expect(p.netProfit).toBe(0);
    expect(trialBalance().balanced).toBe(true);
  });
});

describe('87. balance sheet', () => {
  it('ties assets to liabilities + equity through retained earnings', () => {
    seedJob();
    const bs = balanceSheet(W);

    expect(bs.totalAssets).toBe(9000); // AR 10000 − cash 1000
    expect(bs.totalLiabilities).toBe(6000); // AP
    expect(bs.totalEquity).toBe(3000); // profit for the period
    expect(bs.totalLiabilitiesAndEquity).toBe(9000);
    expect(bs.difference).toBe(0);
    expect(bs.balanced).toBe(true);

    const retained = bs.equity.find((s) => s.key === 'retained-earnings')!;
    expect(retained.rows.find((r) => r.account_id === 'acc:retained-period')!.amount).toBe(3000);
  });

  it('carries VAT as an asset and a liability, and retention as a receivable', () => {
    saveEntry('client-invoice', { date: D, client: 'Gyan Constructions', project: 'PRJ-001', amount: 10000, vat_rate: 13, retention_pct: 10 });
    saveEntry('supplier-bill', { date: D, supplier: 'Sample Steel', project: 'PRJ-001', cost_code: 'Materials', amount: 1000, vat_rate: 13 });

    const bs = balanceSheet(W);
    const assets = bs.assets.flatMap((s) => s.rows);
    const liabilities = bs.liabilities.flatMap((s) => s.rows);

    expect(assets.find((r) => r.account_id === 'acc:ar')!.amount).toBe(10300); // 11300 − 1000 retention
    expect(assets.find((r) => r.account_id === 'acc:retention-ar')!.amount).toBe(1000);
    expect(assets.find((r) => r.account_id === 'acc:vat-input')!.amount).toBe(130);
    expect(liabilities.find((r) => r.account_id === 'acc:vat-output')!.amount).toBe(1300);
    expect(bs.balanced).toBe(true);
  });

  it('rolls the prior periods’ profit into brought-forward retained earnings', () => {
    saveEntry('client-invoice', { date: PRIOR, client: 'Gyan Constructions', project: 'PRJ-001', amount: 5000 });
    saveEntry('client-invoice', { date: D, client: 'Gyan Constructions', project: 'PRJ-001', amount: 10000 });
    const bs = balanceSheet(W);
    expect(bs.retainedBroughtForward).toBe(5000);
    expect(bs.profitForPeriod).toBe(10000);
    expect(bs.totalEquity).toBe(15000);
    expect(bs.balanced).toBe(true);
  });

  it('treats a worker debit balance as an advance and a credit balance as wages owed', () => {
    saveEntry('worker-advance', { date: D, worker_id: 'w1', worker_name: 'Rajesh', amount: 700, method: 'cash' });
    const bs = balanceSheet(W);
    const advances = bs.assets.find((s) => s.key === 'worker-advances');
    expect(advances?.total).toBe(700);
    expect(bs.balanced).toBe(true);
  });
});

describe('88. project P&L', () => {
  it('splits margin by job and leaves overhead out of every job row', () => {
    saveEntry('client-invoice', { date: D, client: 'Gyan Constructions', project: 'PRJ-001', amount: 10000 });
    saveEntry('supplier-bill', { date: D, supplier: 'Sample Steel', project: 'PRJ-001', cost_code: 'Materials', amount: 6000 });
    saveEntry('client-invoice', { date: D, client: 'Other Client', project: 'PRJ-002', amount: 4000 });
    saveEntry('expense-paid', { date: D, category: 'Office', amount: 900, method: 'cash' }); // overhead, no job

    const p = projectPnl(W);
    const p1 = p.rows.find((r) => r.project_id === 'PRJ-001')!;
    const p2 = p.rows.find((r) => r.project_id === 'PRJ-002')!;

    expect(p1.revenue).toBe(10000);
    expect(p1.cost).toBe(6000);
    expect(p1.grossProfit).toBe(4000);
    expect(p1.margin).toBe(40);
    expect(p1.costByKind).toEqual([{ key: 'material', label: 'Materials', amount: 6000 }]);

    expect(p2.cost).toBe(0);
    expect(p2.grossProfit).toBe(4000);

    expect(p.totals.revenue).toBe(14000);
    expect(p.totals.cost).toBe(6000); // the 900 overhead is not a job cost
    expect(Math.abs(round2(p.totals.grossProfit) - 8000)).toBe(0);
    expect(p.rows.every((r) => r.project_id !== 'overhead')).toBe(true);
  });

  it('carries the job’s position to date, independent of the window', () => {
    saveEntry('client-invoice', { date: D, client: 'Gyan Constructions', project: 'PRJ-001', amount: 10000 });
    saveEntry('supplier-bill', { date: D, supplier: 'Sample Steel', project: 'PRJ-001', cost_code: 'Materials', amount: 6000 });
    const row = projectPnl(W).rows.find((r) => r.project_id === 'PRJ-001')!;
    expect(row.billedToDate).toBe(10000); // billed to date, not just this month
  });
});
