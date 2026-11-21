// @vitest-environment jsdom
// Percentage-of-completion WIP: earned revenue, billings, over/under billing.
import { describe, it, expect, beforeEach } from 'vitest';
import { saveEntry, wipReport } from './booksService';
import { upsertProject } from './masterData';

const job = (patch: Record<string, unknown> = {}) => ({
  id: 'PRJ-001',
  name: 'Sample Commercial Complex',
  client: 'Gyan Constructions',
  status: 'active' as const,
  startDate: '',
  endDate: '',
  contractValue: 100000,
  estimatedCost: 80000,
  ...patch,
});

beforeEach(() => localStorage.clear());

describe('WIP percentage of completion', () => {
  it('derives earned revenue, over/under billing and gross profit cost-to-cost', () => {
    upsertProject(job());
    // Cost to date 40,000 (supplier bill)
    saveEntry('supplier-bill', {
      date: '2025-04-20',
      supplier: 'Sample Steel',
      project: 'PRJ-001',
      cost_code: 'Materials',
      qty: 400,
      rate: 100,
      due_days: 30,
    });
    // Billed 30,000 gross with 10% retention
    saveEntry('client-invoice', {
      date: '2025-04-21',
      client: 'Gyan Constructions',
      project: 'PRJ-001',
      amount: 30000,
      retention_pct: 10,
    });

    const { rows } = wipReport();
    const row = rows.find((r) => r.project_id === 'PRJ-001')!;

    expect(row.contract).toBe(100000);
    expect(row.costToDate).toBe(40000);
    expect(row.estimatedCost).toBe(80000);
    expect(row.pctComplete).toBeCloseTo(0.5, 6);
    expect(row.earnedRevenue).toBe(50000); // 50% × 100,000
    expect(row.billings).toBe(30000);
    expect(row.retention).toBe(3000);
    expect(row.overUnder).toBe(-20000); // under-billed: earned 50k vs billed 30k
    expect(row.grossProfit).toBe(10000); // earned 50k − cost 40k
    expect(row.complete).toBe(true);
  });

  it('is cumulative to the requested date', () => {
    upsertProject(job());
    saveEntry('supplier-bill', {
      date: '2025-04-20',
      supplier: 'Sample Steel',
      project: 'PRJ-001',
      cost_code: 'Materials',
      qty: 400,
      rate: 100,
    });
    saveEntry('client-invoice', { date: '2025-05-02', client: 'C', project: 'PRJ-001', amount: 30000, retention_pct: 0 });

    const early = wipReport('2025-04-30').rows.find((r) => r.project_id === 'PRJ-001')!;
    expect(early.costToDate).toBe(40000);
    expect(early.billings).toBe(0); // invoice is next month
    expect(early.overUnder).toBe(-50000);

    const later = wipReport('2025-05-31').rows.find((r) => r.project_id === 'PRJ-001')!;
    expect(later.billings).toBe(30000);
    expect(later.overUnder).toBe(-20000);
  });

  it('refuses to invent a % complete without an estimated cost at completion', () => {
    upsertProject(job({ id: 'PRJ-009', name: 'Annex', contractValue: 5000, estimatedCost: 0 }));
    saveEntry('expense-paid', { date: '2025-04-20', category: 'Materials', project: 'PRJ-009', amount: 1000, method: 'cash' });

    const row = wipReport().rows.find((r) => r.project_id === 'PRJ-009')!;
    expect(row.complete).toBe(false);
    expect(row.pctComplete).toBe(0);
    expect(row.earnedRevenue).toBe(0);
    expect(row.overUnder).toBe(0);
  });

  it('falls back to the BOQ total as contract value for the BOQ project', () => {
    localStorage.setItem(
      'contractoros_boq',
      JSON.stringify([
        {
          id: 's',
          sectionCode: 'A',
          description: 'Substructure',
          amount: 0,
          isSection: true,
          children: [
            { id: '1', itemCode: 'A.01', description: 'x', unit: 'm³', estimatedQuantity: 10, rate: 50, amount: 500, actualMaterialCost: 0, actualLaborCost: 0, completedQuantity: 0 },
          ],
        },
      ])
    );
    upsertProject(job({ contractValue: 0, estimatedCost: 1000 }));
    saveEntry('expense-paid', { date: '2025-04-20', category: 'Materials', project: 'PRJ-001', amount: 250, method: 'cash' });

    const row = wipReport().rows.find((r) => r.project_id === 'PRJ-001')!;
    expect(row.contract).toBe(500);
    expect(row.pctComplete).toBeCloseTo(0.25, 6);
    expect(row.earnedRevenue).toBe(125);
  });
});


