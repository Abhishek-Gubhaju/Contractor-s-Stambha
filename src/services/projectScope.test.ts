// @vitest-environment jsdom
// Every operational dataset is stored per project; switching jobs must not
// leak one job's documents into another.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ACTIVE_PROJECT_KEY,
  DEFAULT_PROJECT_ID,
  SCOPED_BASES,
  SCOPE_BACKUP_KEY,
  SCOPE_MIGRATED_KEY,
  getActiveProject,
  keyFor,
  migrateProjectScope,
  readScoped,
  scopedKey,
  setActiveProject,
  writeScoped,
} from './projectScope';
import { boqTotal, loadBoqItems } from './masterData';

const seedBoq = (key: string, amount: number) =>
  localStorage.setItem(
    key,
    JSON.stringify([
      {
        id: 's',
        sectionCode: 'A',
        description: 'Section',
        amount: 0,
        children: [{ id: '1', itemCode: 'A.01', description: 'Item', unit: 'm3', amount, costCode: '0100' }],
      },
    ])
  );

beforeEach(() => localStorage.clear());

describe('active project', () => {
  it('defaults to the original job and persists switches', () => {
    expect(getActiveProject()).toBe(DEFAULT_PROJECT_ID);
    setActiveProject('prj-002');
    expect(localStorage.getItem(ACTIVE_PROJECT_KEY)).toBe('PRJ-002');
    expect(getActiveProject()).toBe('PRJ-002');
  });

  it('namespaces keys per project', () => {
    expect(scopedKey('contractoros_boq', 'prj-007')).toBe('contractoros_boq::PRJ-007');
  });
});

describe('scoped storage', () => {
  it('keeps projects isolated in both directions', () => {
    writeScoped('contractoros_boq', [{ id: 'a' }], 'PRJ-001');
    writeScoped('contractoros_boq', [{ id: 'b' }], 'PRJ-002');

    expect(readScoped('contractoros_boq', [], 'PRJ-001')).toEqual([{ id: 'a' }]);
    expect(readScoped('contractoros_boq', [], 'PRJ-002')).toEqual([{ id: 'b' }]);
    expect(localStorage.getItem('contractoros_boq')).toBeNull();
  });

  it('reads pre-scope data for the original job only', () => {
    seedBoq('contractoros_boq', 5000);

    expect(readScoped('contractoros_boq', [], 'PRJ-001')).toHaveLength(1);
    expect(readScoped('contractoros_boq', [], 'PRJ-002')).toEqual([]);
    expect(keyFor('contractoros_boq', 'PRJ-001')).toBe('contractoros_boq');
    expect(keyFor('contractoros_boq', 'PRJ-002')).toBe('contractoros_boq::PRJ-002');
  });

  it('prefers the scoped copy once it exists', () => {
    seedBoq('contractoros_boq', 5000);
    seedBoq('contractoros_boq::PRJ-001', 8000);

    expect(readScoped<any[]>('contractoros_boq', [], 'PRJ-001')[0].children[0].amount).toBe(8000);
  });
});

describe('migration', () => {
  it('copies legacy data to the original project and records a backup', () => {
    seedBoq('contractoros_boq', 4000);
    localStorage.setItem('contractoros_staff', JSON.stringify([{ id: 'w1' }]));

    const first = migrateProjectScope();
    expect(first.migrated).toBeGreaterThanOrEqual(2);

    const scoped = JSON.parse(localStorage.getItem(scopedKey('contractoros_boq', 'PRJ-001'))!);
    expect(scoped[0].children[0].amount).toBe(4000);
    // originals retained as the recovery copy
    expect(localStorage.getItem('contractoros_boq')).toContain('4000');

    const backup = JSON.parse(localStorage.getItem(SCOPE_BACKUP_KEY)!);
    expect(backup.sourceKeys).toContain('contractoros_boq');
    expect(localStorage.getItem(SCOPE_MIGRATED_KEY)).toBe('1');
  });

  it('is idempotent and never overwrites an existing project copy', () => {
    seedBoq('contractoros_boq', 4000);
    seedBoq(scopedKey('contractoros_boq', 'PRJ-001'), 9000);

    migrateProjectScope();
    expect(readScoped<any[]>('contractoros_boq', [], 'PRJ-001')[0].children[0].amount).toBe(9000);

    const second = migrateProjectScope();
    expect(second.migrated).toBe(0);
    expect(SCOPED_BASES.length).toBeGreaterThan(0);
  });
});

describe('BOQ totals per project', () => {
  it('prices each project from its own document', () => {
    seedBoq('contractoros_boq', 1000);
    seedBoq(scopedKey('contractoros_boq', 'PRJ-002'), 2500);

    expect(boqTotal('PRJ-001')).toBe(1000);
    expect(boqTotal('PRJ-002')).toBe(2500);
    expect(loadBoqItems('PRJ-002')).toHaveLength(1);
    expect(loadBoqItems('PRJ-003')).toEqual([]);
  });
});
