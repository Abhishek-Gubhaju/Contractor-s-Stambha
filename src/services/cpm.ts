// ============================================================================
// cpm.ts — Critical Path Method (longest path) over the activity graph (B6).
// Forward pass (ES/EF) → backward pass (LS/LF) → total float → critical set.
// Handles FS/SS/FF/SF with lag; tolerates cycles by ignoring back-edges.
// ============================================================================
import { Activity, Dependency, DAY_MS } from './dsrSyncService';

export interface CpmResult {
  criticalIds: string[];
  earliest: Record<string, { es: number; ef: number }>; // day offsets from epoch
  float: Record<string, number>;
}

function durationDays(a: Activity): number {
  if (!a.start || !a.end) return 1;
  const s = Date.parse(`${a.start.slice(0, 10)}T00:00:00Z`);
  const e = Date.parse(`${a.end.slice(0, 10)}T00:00:00Z`);
  return Math.max(1, Math.round((e - s) / DAY_MS) + 1); // inclusive days
}

/** Kahn topological order; back-edges (cycles) are dropped, not followed. */
function topoOrder(ids: string[], deps: Dependency[]): { order: string[]; safe: Dependency[] } {
  const indeg = new Map<string, number>(ids.map((id) => [id, 0] as const));
  const safe: Dependency[] = deps.filter((d) => indeg.has(d.from_id) && indeg.has(d.to_id) && d.from_id !== d.to_id);
  for (const d of safe) indeg.set(d.to_id, (indeg.get(d.to_id) || 0) + 1);
  const queue = ids.filter((id) => (indeg.get(id) || 0) === 0);
  const order: string[] = [];
  const consumed: Dependency[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const d of safe.filter((s) => s.from_id === id)) {
      consumed.push(d);
      const n = (indeg.get(d.to_id) || 0) - 1;
      indeg.set(d.to_id, n);
      if (n === 0) queue.push(d.to_id);
    }
  }
  // any ids not reached sit in a cycle — append them without their back-edges
  for (const id of ids) if (!order.includes(id)) order.push(id);
  const consumedSet = new Set(consumed.map((c) => c.id));
  return { order, safe: safe.filter((d) => consumedSet.has(d.id)) };
}

/**
 * Earliest start offset for `to` given a dependency from `from`:
 * FS: after predecessor finishes · SS: when predecessor starts
 * FF: when predecessor finishes · SF: after predecessor starts
 */
function forwardOffset(type: Dependency['type'], fromES: number, fromEF: number, lag: number): number {
  switch (type) {
    case 'FS':
      return fromEF + lag;
    case 'SS':
      return fromES + lag;
    case 'FF':
      return fromEF + lag; // successor finishes with predecessor → its start = EF + lag − dur (applied by caller)
    case 'SF':
      return fromES + lag;
  }
}

export function computeCpm(activities: Activity[], deps: Dependency[]): CpmResult {
  const byId = new Map(activities.map((a) => [a.id, a] as const));
  const ids = activities.map((a) => a.id);
  const { order, safe } = topoOrder(ids, deps);

  const dur = new Map<string, number>(activities.map((a) => [a.id, durationDays(a)]));
  const earliest: Record<string, { es: number; ef: number }> = {};
  for (const id of ids) earliest[id] = { es: 0, ef: 0 };

  // Forward pass
  for (const id of order) {
    const preds = safe.filter((d) => d.to_id === id);
    let es = 0;
    for (const d of preds) {
      const src = earliest[d.from_id];
      if (!src) continue;
      const offset =
        d.type === 'FF'
          ? forwardOffset(d.type, src.es, src.ef, d.lag_days) - (dur.get(id) || 1)
          : forwardOffset(d.type, src.es, src.ef, d.lag_days);
      es = Math.max(es, offset);
    }
    earliest[id] = { es, ef: es + (dur.get(id) || 1) };
  }

  // Backward pass — project ends at the overall EF
  const projectEnd = Math.max(0, ...ids.map((id) => earliest[id].ef));
  const latest: Record<string, number> = {}; // LF offsets
  for (const id of ids) latest[id] = projectEnd;
  const rev = [...order].reverse();
  for (const id of rev) {
    const succs = safe.filter((d) => d.from_id === id);
    let lf = projectEnd;
    for (const d of succs) {
      const tgtLS = latest[d.to_id] - (dur.get(d.to_id) || 1);
      const offset = (() => {
        switch (d.type) {
          case 'FS':
            return tgtLS - d.lag_days;
          case 'SS':
            return tgtLS + (dur.get(d.to_id) || 1) - d.lag_days;
          case 'FF':
            return tgtLS + (dur.get(d.to_id) || 1) - d.lag_days;
          case 'SF':
            return tgtLS + (dur.get(d.to_id) || 1) + d.lag_days;
        }
      })();
      lf = Math.min(lf, offset);
    }
    latest[id] = lf;
  }

  const float: Record<string, number> = {};
  const criticalIds: string[] = [];
  for (const id of ids) {
    const ls = latest[id] - (dur.get(id) || 1);
    float[id] = ls - earliest[id].es;
    if (float[id] <= 0) criticalIds.push(id);
  }
  void byId;
  return { criticalIds, earliest, float };
}

/** FS mapping helper used by the renderer to place arrow anchors (B5). */
export const ANCHOR_HELPERS = { forwardOffset };
