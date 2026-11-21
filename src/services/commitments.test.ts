// @vitest-environment jsdom
// Open purchase orders and subcontracts feed the job forecast:
//   forecast = accrued actual cost + open commitments.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  commitmentTotals,
  committedByKey,
  isOpenCommitment,
  loadCommitments,
  removeCommitment,
  setCommitmentStatus,
  upsertCommitment,
} from './commitments';
import { jobCost, jobCostByCode, saveEntry } from './booksService';

const D = '2025-04-20';

describe('commitment dates', () => {
  it('defaults to the Kathmandu day, not the UTC day', () => {
    vi.useFakeTimers();
    // 20:00 UTC is 01:45 the next morning in Nepal.
    vi.setSystemTime(new Date('2026-11-17T20:00:00Z'));
    try {
      const c = upsertCommitment({ vendor: 'Ram Store', amount: 100 });
      expect(c.date).toBe('2026-11-18');
    } finally {
      vi.useRealTimers();
    }
  });
});

const seedBoqBudget = (amount = 10000) =>
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
          {
            id: '1',
            sectionCode: 'A',
            itemCode: 'A.01',
            description: 'Excavation',
            unit: 'm³',
            estimatedQuantity: 100,
            rate: 100,
            amount,
            actualMaterialCost: 0,
            actualLaborCost: 0,
            completedQuantity: 0,
            costCode: '0100',
          },
        ],
      },
    ])
  );

beforeEach(() => localStorage.clear());

describe('commitment register', () => {
  it('starts empty and validates input', () => {
    expect(loadCommitments()).toEqual([]);
    expect(() => upsertCommitment({ amount: 0, ref: 'PO-1' })).toThrow(/greater than zero/i);
    expect(() => upsertCommitment({ amount: 100 })).toThrow(/reference number or vendor/i);
  });

  it('counts only approved and ordered commitments as open', () => {
    const po = upsertCommitment({ ref: 'PO-1', vendor: 'Tata', project_id: 'prj-001', cost_code: 'Materials', amount: 5000, status: 'approved' });
    const sub = upsertCommitment({ ref: 'SC-1', vendor: 'Ace', project_id: 'PRJ-001', cost_code: 'Subcontractor', amount: 2000, status: 'ordered' });
    const draft = upsertCommitment({ ref: 'PO-2', vendor: 'X', project_id: 'PRJ-001', amount: 900, status: 'draft' });
    const received = upsertCommitment({ ref: 'PO-3', vendor: 'Y', project_id: 'PRJ-001', amount: 800, status: 'received' });

    expect(po.project_id).toBe('PRJ-001');
    expect(isOpenCommitment(po)).toBe(true);
    expect(isOpenCommitment(sub)).toBe(true);
    expect(isOpenCommitment(draft)).toBe(false);
    expect(isOpenCommitment(received)).toBe(false);

    const totals = commitmentTotals();
    expect(totals.count).toBe(2);
    expect(totals.total).toBe(7000);

    // releasing a commitment removes it from the forecast
    setCommitmentStatus(po.id, 'received');
    expect(commitmentTotals().total).toBe(2000);

    removeCommitment(sub.id);
    expect(commitmentTotals().count).toBe(0);
  });

  it('keeps unallocated commitments out of the job-keyed forecast', () => {
    upsertCommitment({ ref: 'PO-1', vendor: 'Tata', project_id: '', cost_code: 'Materials', amount: 1500, status: 'approved' });
    expect(committedByKey().size).toBe(0);
    const totals = commitmentTotals();
    expect(totals.total).toBe(1500);
    expect(totals.allocated).toBe(0);
    expect(totals.unallocated).toBe(1500);
  });
});

describe('committed cost in job costing', () => {
  it('forecast = accrued + open commitments, per project and cost code', () => {
    seedBoqBudget(10000);
    saveEntry('supplier-bill', {
      date: D,
      supplier: 'Sample Steel',
      project: 'PRJ-001',
      cost_code: 'Materials',
      qty: 10,
      rate: 100,
      due_days: 30,
    });
    upsertCommitment({ ref: 'PO-9', vendor: 'ACC', project_id: 'PRJ-001', cost_code: 'Materials', amount: 5000, status: 'approved' });

    const row = jobCostByCode('PRJ-001').codes.find((c) => c.code === '0100')!;
    expect(row.accrued).toBe(1000);
    expect(row.committed).toBe(5000);
    expect(row.forecast).toBe(6000);
    expect(row.budget).toBe(10000);
    expect(row.variance).toBe(9000); // budget − accrued (actuals only)
    expect(row.forecastVariance).toBe(4000); // budget − forecast

    const project = jobCost().find((r) => r.project_id === 'PRJ-001')!;
    expect(project.committed).toBe(5000);
    expect(project.forecast).toBe(6000);
  });

  it('shows a cost code that has commitments but no invoice yet', () => {
    upsertCommitment({ ref: 'SC-2', vendor: 'Ace', project_id: 'PRJ-001', cost_code: 'Subcontractor', amount: 3000, status: 'ordered' });

    const row = jobCostByCode('PRJ-001').codes.find((c) => c.code === '0400')!;
    expect(row.accrued).toBe(0);
    expect(row.committed).toBe(3000);
    expect(row.forecast).toBe(3000);
  });

  it('drops a commitment from the forecast once it is received', () => {
    const po = upsertCommitment({ ref: 'PO-9', vendor: 'ACC', project_id: 'PRJ-001', cost_code: 'Materials', amount: 5000, status: 'approved' });
    expect(jobCost().find((r) => r.project_id === 'PRJ-001')!.committed).toBe(5000);

    setCommitmentStatus(po.id, 'received');
    // Nothing incurred and nothing still promised → the job leaves the report.
    expect(jobCost().find((r) => r.project_id === 'PRJ-001')).toBeUndefined();
    expect(jobCostByCode('PRJ-001').codes.find((c) => c.code === '0100')).toBeUndefined();
  });
});
