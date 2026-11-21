// ============================================================================
// commitments — money already promised on a job.
//
// A purchase order or subcontract is a commitment: the cost is contractually
// incurred even though the invoice may land next month. Job forecasting needs
// three numbers, not two:
//
//   accrued (actual)  +  open commitments  =  forecast cost
//
// Received/cancelled commitments are no longer open (the cost, if any, is now
// an accrued invoice). Draft/unapproved ones are not firm, so they do not count.
// ============================================================================

import { costCodeOf } from './masterData';
import { readScoped, writeScoped } from './projectScope';
import { todayISOInKathmandu } from '../utils';

export const COMMITMENTS_KEY = 'contractoros_commitments';

export type CommitmentKind = 'po' | 'subcontract';

export type CommitmentStatus = 'draft' | 'approved' | 'ordered' | 'received' | 'cancelled';

export interface Commitment {
  id: string;
  kind: CommitmentKind;
  /** PO number / subcontract reference. */
  ref: string;
  vendor: string;
  project_id: string;
  /** Cost-code master name or code (resolved at read time). */
  cost_code: string;
  amount: number;
  status: CommitmentStatus;
  date: string;
  note: string;
}

/** Statuses that represent firm, still-uninvoiced money. */
export const OPEN_COMMITMENT_STATUSES: CommitmentStatus[] = ['approved', 'ordered'];

export const COMMITMENT_STATUSES: CommitmentStatus[] = ['draft', 'approved', 'ordered', 'received', 'cancelled'];

export function isOpenCommitment(c: Commitment): boolean {
  return OPEN_COMMITMENT_STATUSES.includes(c.status);
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

// Commitments are that job's promises: scoped like every other cost record.
function readJSON<T>(key: string, fallback: T): T {
  return readScoped<T>(key, fallback);
}

function writeJSON(key: string, value: unknown) {
  writeScoped(key, value);
}

function emitChange() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('contractoros:commitments-changed'));
  }
}

export function loadCommitments(): Commitment[] {
  const stored = readJSON<Commitment[]>(COMMITMENTS_KEY, []);
  if (!Array.isArray(stored)) return [];
  return stored
    .filter((c) => c && typeof c.id === 'string')
    .map((c) => ({
      ...c,
      kind: c.kind === 'subcontract' ? 'subcontract' : 'po',
      ref: String(c.ref || ''),
      vendor: String(c.vendor || ''),
      project_id: String(c.project_id || ''),
      cost_code: String(c.cost_code || ''),
      amount: round2(c.amount),
      status: COMMITMENT_STATUSES.includes(c.status) ? c.status : 'draft',
      date: String(c.date || ''),
      note: String(c.note || ''),
    }));
}

function saveCommitments(list: Commitment[]) {
  writeJSON(COMMITMENTS_KEY, list);
  emitChange();
}

function newId(): string {
  return `CM-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function upsertCommitment(input: Partial<Commitment> & { amount: number }): Commitment {
  const ref = String(input.ref || '').trim();
  const vendor = String(input.vendor || '').trim();
  if (!ref && !vendor) throw new Error('A reference number or vendor is required.');
  const amount = round2(input.amount);
  if (!(amount > 0)) throw new Error('Commitment amount must be greater than zero.');

  const projectId = String(input.project_id || '').trim().toUpperCase();
  const costCode = String(input.cost_code || '').trim();

  const commitment: Commitment = {
    id: input.id || newId(),
    kind: input.kind === 'subcontract' ? 'subcontract' : 'po',
    ref: ref || vendor,
    vendor,
    project_id: projectId,
    cost_code: costCode,
    amount,
    status: input.status && COMMITMENT_STATUSES.includes(input.status) ? input.status : 'approved',
    date: String(input.date || todayISOInKathmandu()),
    note: String(input.note || ''),
  };

  const list = loadCommitments().filter((c) => c.id !== commitment.id);
  saveCommitments([...list, commitment].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)));
  return commitment;
}

export function setCommitmentStatus(id: string, status: CommitmentStatus) {
  if (!COMMITMENT_STATUSES.includes(status)) throw new Error(`Unknown commitment status: ${status}`);
  saveCommitments(loadCommitments().map((c) => (c.id === id ? { ...c, status } : c)));
}

export function removeCommitment(id: string) {
  saveCommitments(loadCommitments().filter((c) => c.id !== id));
}

/**
 * Open committed cost keyed `project|cost-code` so job costing can join it to
 * the same dimension it already rolls actuals up by.
 */
export function committedByKey(): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of loadCommitments()) {
    if (!isOpenCommitment(c) || !c.project_id) continue;
    // Resolve the code lazily to avoid a circular import at module load.
    const code = resolveCode(c.cost_code);
    const key = `${c.project_id}|${code}`;
    out.set(key, round2((out.get(key) || 0) + c.amount));
  }
  return out;
}

export function committedForProject(projectId: string): number {
  const id = String(projectId || '').trim().toUpperCase();
  let total = 0;
  for (const [key, amount] of committedByKey()) if (key.startsWith(`${id}|`)) total += amount;
  return round2(total);
}

export interface CommitmentTotals {
  total: number; // all open commitments
  allocated: number; // open commitments with a job
  unallocated: number; // open commitments with no job yet
  count: number; // open commitments
}

export function commitmentTotals(): CommitmentTotals {
  let total = 0;
  let allocated = 0;
  let count = 0;
  for (const c of loadCommitments()) {
    if (!isOpenCommitment(c)) continue;
    count++;
    total += c.amount;
    if (c.project_id) allocated += c.amount;
  }
  return {
    total: round2(total),
    allocated: round2(allocated),
    unallocated: round2(total - allocated),
    count,
  };
}

function resolveCode(value: string): string {
  return costCodeOf(value)?.code || '0000';
}
