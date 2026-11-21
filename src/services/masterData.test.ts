// @vitest-environment jsdom
// Project + cost-code masters, and job costing rolled up by both dimensions.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  BOQ_PROJECT_ID,
  costCodeOf,
  ensureProject,
  loadCostCodes,
  loadProjects,
  projectNameOf,
  removeCostCode,
  removeProject,
  upsertCostCode,
} from './masterData';
import { getActiveProject, setActiveProject } from './projectScope';
import { jobCostByCode, saveEntry, syncBoqActuals } from './booksService';

const D = '2025-04-20';

const seedBoq = (costCode = '0100') =>
  localStorage.setItem(
    'contractoros_boq',
    JSON.stringify([
      {
        id: 's1',
        sectionCode: 'A',
        description: 'Substructure',
        amount: 0,
        isSection: true,
        children: [
          {
            id: '1',
            sectionCode: 'A',
            itemCode: 'A.01',
            description: 'Site Clearance & Excavation',
            unit: 'm³',
            estimatedQuantity: 100,
            rate: 10,
            amount: 1000,
            actualMaterialCost: 0,
            actualLaborCost: 0,
            completedQuantity: 0,
            costCode,
          },
        ],
      },
    ])
  );

beforeEach(() => localStorage.clear());

describe('project master', () => {
  it('starts with no jobs at all — nothing is invented for the user', () => {
    expect(loadProjects()).toEqual([]);
    // with no job registered the label falls back to the job number itself
    expect(projectNameOf(BOQ_PROJECT_ID)).toBe('PRJ-001');
  });

  it('resolves job ids case-insensitively once a job exists', () => {
    ensureProject(BOQ_PROJECT_ID, 'Hillside Tower');
    expect(projectNameOf('prj-001')).toBe('Hillside Tower');
  });

  it('auto-registers an unknown job number from a posting', () => {
    const created = ensureProject('prj-042', 'Sample Annex');
    expect(created?.id).toBe('PRJ-042');
    expect(loadProjects().some((p) => p.id === 'PRJ-042')).toBe(true);
    expect(ensureProject('')).toBeNull();
  });

  it('moves the open job off a project that is deleted', () => {
    ensureProject('PRJ-001', 'First');
    ensureProject('PRJ-002', 'Second');
    setActiveProject('PRJ-002');
    removeProject('PRJ-002');
    expect(getActiveProject()).toBe('PRJ-001');
  });
});

describe('cost-code master', () => {
  it('resolves a stored category name to its numeric code and back', () => {
    expect(costCodeOf('Materials')?.code).toBe('0100');
    expect(costCodeOf('0100')?.name).toBe('Materials');
    expect(costCodeOf('materials')?.code).toBe('0100');
    expect(costCodeOf('Not a real code')).toBeNull();
  });

  it('rejects a code without a name and keeps codes unique by name', () => {
    expect(() => upsertCostCode({ code: '1700', name: '  ' })).toThrow(/name/i);
    upsertCostCode({ code: '1700', name: 'Scaffolding' });
    upsertCostCode({ code: '1750', name: 'Scaffolding' });
    const matches = loadCostCodes().filter((c) => c.name === 'Scaffolding');
    expect(matches).toHaveLength(1);
    expect(matches[0].code).toBe('1750');
  });

  it('keeps an intentionally empty list empty instead of restoring the seeds', () => {
    for (const code of loadCostCodes()) removeCostCode(code.code);
    expect(loadCostCodes()).toEqual([]);
    upsertCostCode({ code: '0100', name: 'Materials' });
    expect(loadCostCodes().map((c) => c.code)).toEqual(['0100']);
  });
});

describe('job costing by project and cost code', () => {
  it('splits accrued cost by cost code and reads budgets from tagged BOQ items', () => {
    seedBoq('0100');
    saveEntry('supplier-bill', {
      date: D,
      supplier: 'Sample Steel',
      project: 'PRJ-001',
      cost_code: 'Materials',
      qty: 10,
      rate: 100,
      due_days: 30,
    });
    saveEntry('expense-paid', { date: D, category: 'Transport', project: 'PRJ-001', amount: 250, method: 'cash' });

    const { codes, projects } = jobCostByCode('PRJ-001');
    const materials = codes.find((c) => c.code === '0100')!;
    expect(materials.accrued).toBe(1000);
    expect(materials.budget).toBe(1000); // BOQ item tagged 0100
    expect(materials.variance).toBe(0);

    const transport = codes.find((c) => c.code === '0200')!;
    expect(transport.accrued).toBe(250);
    expect(transport.budget).toBe(0);
    expect(transport.variance).toBe(-250);

    expect(projects.find((p) => p.project_id === 'PRJ-001')!.accrued).toBe(1250);
    // unknown job numbers appear as their own dimension, never merged
    expect(codes.every((c) => c.project_id === 'PRJ-001')).toBe(true);
  });

  it('keeps two jobs separate when they use the same cost code', () => {
    saveEntry('expense-paid', { date: D, category: 'Materials', project: 'PRJ-001', amount: 100, method: 'cash' });
    saveEntry('expense-paid', { date: D, category: 'Materials', project: 'PRJ-002', amount: 300, method: 'cash' });

    const { codes } = jobCostByCode();
    const one = codes.find((c) => c.project_id === 'PRJ-001' && c.code === '0100')!;
    const two = codes.find((c) => c.project_id === 'PRJ-002' && c.code === '0100')!;
    expect(one.accrued).toBe(100);
    expect(two.accrued).toBe(300);
  });
});

describe('postings write actuals back to BOQ items', () => {
  it('routes material and labour cost into the right BOQ columns', () => {
    seedBoq('0100');
    saveEntry('supplier-bill', {
      date: D,
      supplier: 'Sample Steel',
      project: 'PRJ-001',
      cost_code: 'Materials',
      boq_code: 'A.01',
      qty: 10,
      rate: 100,
      due_days: 30,
    });

    let item = JSON.parse(localStorage.getItem('contractoros_boq')!)[0].children[0];
    expect(item.actualMaterialCost).toBe(1000);
    expect(item.actualLaborCost).toBe(0);

    saveEntry('payroll-accrual', {
      date: D,
      ref: 'PAY-1',
      workers: [{ worker_id: 'w1', name: 'Ram', amount: 400 }],
      project_splits: [{ project_id: 'PRJ-001', amount: 400, boq_code: 'A.01' }],
    });

    item = JSON.parse(localStorage.getItem('contractoros_boq')!)[0].children[0];
    expect(item.actualMaterialCost).toBe(1000);
    expect(item.actualLaborCost).toBe(400);
  });

  it('is derived, not incremental: re-syncing does not double-count', () => {
    seedBoq('0100');
    saveEntry('supplier-bill', {
      date: D,
      supplier: 'Tata',
      project: 'PRJ-001',
      cost_code: 'Materials',
      boq_code: 'A.01',
      qty: 10,
      rate: 100,
    });

    expect(JSON.parse(localStorage.getItem('contractoros_boq')!)[0].children[0].actualMaterialCost).toBe(1000);

    // Every sync recomputes the whole column from entry_lines.
    expect(syncBoqActuals().updated).toBe(0); // already in sync
    expect(JSON.parse(localStorage.getItem('contractoros_boq')!)[0].children[0].actualMaterialCost).toBe(1000);
  });

  it('leaves an untouched BOQ document alone', () => {
    seedBoq('0100');
    const before = localStorage.getItem('contractoros_boq');
    expect(syncBoqActuals().updated).toBe(0);
    expect(localStorage.getItem('contractoros_boq')).toBe(before);
  });
});
