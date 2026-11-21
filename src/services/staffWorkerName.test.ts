// @vitest-environment jsdom
// Staff records are entered as first/middle/last name + code, while imported
// records carry fullName. The worker master must read both — and never show a
// raw id where a person's name belongs.
import { describe, it, expect, beforeEach } from 'vitest';
import { loadWorkers, workerLabel, staffWorkerName } from './labourService';
import { scopedKey } from './projectScope';

function seedStaff(rows: any[]) {
  localStorage.setItem(scopedKey('contractoros_staff', 'PRJ-001'), JSON.stringify(rows));
}

beforeEach(() => localStorage.clear());

describe('staff names in the worker master', () => {
  it('builds the name from first / middle / last and keeps the staff code', () => {
    seedStaff([{ id: 'staff-1', code: 'STF-001', firstName: 'Asha', middleName: 'K', lastName: 'Rai', status: 'active' }]);
    const worker = loadWorkers().find((w) => w.id === 'staff:staff-1')!;
    expect(worker.name).toBe('Asha K Rai');
    expect(worker.code).toBe('STF-001');
  });

  it('still reads older records that only have fullName', () => {
    seedStaff([{ id: 'staff-2', code: 'STF-002', fullName: 'Old Import' }]);
    expect(loadWorkers().find((w) => w.id === 'staff:staff-2')!.name).toBe('Old Import');
  });

  it('never falls back to the raw id', () => {
    seedStaff([{ id: 'staff-3', code: 'STF-003' }]);
    const worker = loadWorkers().find((w) => w.id === 'staff:staff-3')!;
    expect(worker.name).toBe('Staff STF-003');
    expect(worker.name).not.toContain('staff:staff-3');

    expect(staffWorkerName({ id: 'x' })).toBe('Unnamed staff');
    expect(staffWorkerName({ firstName: '  ', lastName: 'Rai' })).toBe('Rai');
  });
});

describe('worker labels', () => {
  it('shows a plain name when it is unique', () => {
    const workers = [
      { id: 'staff:1', name: 'Asha Rai', code: 'STF-001' },
      { id: 'staff:2', name: 'Ram Thapa', code: 'STF-002' },
    ] as any;
    expect(workerLabel(workers[0], workers)).toBe('Asha Rai');
    expect(workerLabel(workers[1], workers)).toBe('Ram Thapa');
  });

  it('adds the staff number only when two people share a name', () => {
    const workers = [
      { id: 'staff:1', name: 'Asha Rai', code: 'STF-001' },
      { id: 'staff:2', name: 'asha  rai ', code: 'STF-002' },
      { id: 'staff:3', name: 'Ram Thapa', code: 'STF-003' },
    ] as any;
    expect(workerLabel(workers[0], workers)).toBe('Asha Rai (STF-001)');
    expect(workerLabel(workers[1], workers)).toBe('asha  rai (STF-002)');
    expect(workerLabel(workers[2], workers)).toBe('Ram Thapa');
  });

  it('falls back to the id when a duplicate has no code', () => {
    const workers = [
      { id: 'w1', name: 'Abdul Khan' },
      { id: 'w2', name: 'Abdul Khan' },
    ] as any;
    expect(workerLabel(workers[1], workers)).toBe('Abdul Khan (w2)');
  });
});
