import { describe, it, expect } from 'vitest';
import { computeCpm } from './cpm';
import type { Activity, Dependency } from './dsrSyncService';

function act(id: string, start: string, end: string, extra: Partial<Activity> = {}): Activity {
  return {
    id,
    code: id,
    name: id,
    sector: 'S',
    start,
    end,
    progress: 0,
    status_cache: 'planned',
    baseline_start: start,
    baseline_end: end,
    actual_start: null,
    actual_finish: null,
    forecast_finish: null,
    is_milestone: false,
    synced_at: null,
    ...extra,
  };
}

function dep(from: string, to: string, type: Dependency['type'] = 'FS', lag = 0): Dependency {
  return { id: `${from}->${to}`, from_id: from, to_id: to, type, lag_days: lag };
}

describe('cpm — critical path is the true longest path (B6)', () => {
  it('marks the longest chain critical and excludes a shorter parallel branch', () => {
    // main chain A(3d) → B(3d) → C(3d); short branch D(1d) → C
    const acts = [
      act('A', '2026-01-01', '2026-01-03'),
      act('B', '2026-01-04', '2026-01-06'),
      act('C', '2026-01-07', '2026-01-09'),
      act('D', '2026-01-01', '2026-01-01'),
    ];
    const deps = [dep('A', 'B'), dep('B', 'C'), dep('D', 'C')];
    const res = computeCpm(acts, deps);
    expect([...res.criticalIds].sort()).toEqual(['A', 'B', 'C']);
    expect(res.float.D).toBeGreaterThan(0); // branch has slack
    expect(res.float.A).toBe(0);
    expect(res.float.C).toBe(0);
    expect(res.earliest.C.es).toBe(res.earliest.B.ef); // FS chaining in forward pass
  });

  it('FS lag shifts earliest start by the lag; predecessor stays critical when successor has no float', () => {
    const acts = [act('A', '2026-01-01', '2026-01-03'), act('B', '2026-01-04', '2026-01-06')];
    const deps = [dep('A', 'B', 'FS', 2)];
    const res = computeCpm(acts, deps);
    // forward pass honors lag: B starts 2 days after A finishes
    expect(res.earliest.B.es).toBe(res.earliest.A.ef + 2);
    // backward pass honors lag symmetrically: LF(A) = LS(B) − lag
    expect(res.float.B).toBe(0);
    expect(res.float.A).toBe(0); // a fixed gap is not slack — delaying A delays the project
    expect([...res.criticalIds].sort()).toEqual(['A', 'B']);
  });

  it('the milestone sitting on the long branch goes critical; slack milestone does not', () => {
    // mirrors the seeded fixture: A.01 → A.02 → ms:m2 (long path), A.01 → ms:m1 (short)
    const acts = [
      act('act:A.01', '2026-09-15', '2026-09-20'),
      act('act:A.02', '2026-09-15', '2026-09-20'),
      act('ms:m1', '2026-09-15', '2026-09-20', { is_milestone: true }),
      act('ms:m2', '2026-09-15', '2026-09-20', { is_milestone: true }),
    ];
    const deps = [
      dep('act:A.01', 'act:A.02'),
      dep('act:A.01', 'ms:m1'),
      dep('act:A.02', 'ms:m2'),
    ];
    const res = computeCpm(acts, deps);
    expect([...res.criticalIds].sort()).toEqual(['act:A.01', 'act:A.02', 'ms:m2']);
    expect(res.float['ms:m1']).toBeGreaterThan(0);
  });

  it('tolerates dependency cycles instead of hanging', () => {
    const acts = [act('A', '2026-01-01', '2026-01-02'), act('B', '2026-01-03', '2026-01-04')];
    const res = computeCpm(acts, [dep('A', 'B'), dep('B', 'A')]);
    expect(res.criticalIds.length).toBeGreaterThan(0);
    expect(res.criticalIds.every((id) => id === 'A' || id === 'B')).toBe(true);
  });

  it('handles an empty graph', () => {
    const res = computeCpm([], []);
    expect(res.criticalIds).toEqual([]);
  });
});
