// ============================================================================
// masterData — the PROJECT and COST CODE masters (single source of truth).
//
// Job costing needs two stable dimensions: the job (project) and the cost code.
// Before this module both were free text ("PRJ-001" typed into a hopper input,
// a category string on the line), which meant costs could silently land on a
// second, budget-less job and no view could say WHICH trade overspent.
//
// • Projects: id (job number), name, client, status, dates.
// • Cost codes: numeric code + name + kind. The ledger line still stores the
//   category NAME in `cost_code` (historical data stays readable); the code is
//   resolved through this master for every roll-up.
// • Unknown ids/names are auto-registered on write, so existing data and the
//   seeded BOQ keep posting without being rejected mid-entry.
// ============================================================================

import { DEFAULT_PROJECT_ID, getActiveProject, readScoped, setActiveProject, writeScoped } from './projectScope';

export const PROJECTS_KEY = 'contractoros_projects';
export const COST_CODES_KEY = 'contractoros_cost_codes';
export const BOQ_KEY = 'contractoros_boq';

/** The original job: pre-scope data and the seeded BOQ belong to it. */
export const BOQ_PROJECT_ID = DEFAULT_PROJECT_ID;

export type CostCodeKind = 'material' | 'labour' | 'subcontract' | 'equipment' | 'other';

export interface CostCode {
  code: string;
  name: string;
  kind: CostCodeKind;
}

export type ProjectStatus = 'active' | 'on-hold' | 'completed';

export interface Project {
  id: string;
  name: string;
  client: string;
  status: ProjectStatus;
  startDate: string;
  endDate: string;
  /** Contract/selling value. Falls back to the BOQ total for the BOQ project. */
  contractValue?: number;
  /** Estimated total cost at completion — the denominator of % complete. */
  estimatedCost?: number;
}

// Labour is owned by payroll; these names may never be booked as an expense
// directly (the hopper blocks them). Kept here so the master and the posting
// engine agree on one list.
export const LABOUR_EXPENSE_CATEGORIES = [
  'Labour',
  'Salary',
  'Staff Salary Expense',
  'Construction Labor',
  'Payroll',
];

export function slug(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function isLabourCategory(category: string): boolean {
  return LABOUR_EXPENSE_CATEGORIES.map(slug).includes(slug(category));
}

export const SEED_COST_CODES: CostCode[] = [
  { code: '0100', name: 'Materials', kind: 'material' },
  { code: '0200', name: 'Transport', kind: 'other' },
  { code: '0300', name: 'Labour', kind: 'labour' },
  { code: '0400', name: 'Subcontractor', kind: 'subcontract' },
  { code: '0500', name: 'Rent', kind: 'other' },
  { code: '0600', name: 'Utilities', kind: 'other' },
  { code: '0700', name: 'Office', kind: 'other' },
  { code: '0800', name: 'Travel', kind: 'other' },
  { code: '0900', name: 'Entertainment', kind: 'other' },
  { code: '1000', name: 'Repairs & Maintenance', kind: 'other' },
  { code: '1100', name: 'Equipment', kind: 'equipment' },
  { code: '1200', name: 'Taxes', kind: 'other' },
  { code: '1300', name: 'Interest', kind: 'other' },
  { code: '1400', name: 'Salary', kind: 'labour' },
  { code: '1500', name: 'Others', kind: 'other' },
];

// A fresh install starts with no jobs at all: the first job is whatever the
// contractor creates in Settings. Nothing is invented on their behalf.
export const SEED_PROJECTS: Project[] = [];

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

// Unscoped on purpose: these two helpers are only used for the job registry,
// which is the one master shared by every job.
function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full/blocked — masters stay in memory for this session */
  }
}

function emitChange() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('contractoros:masters-changed'));
  }
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------
export function loadProjects(): Project[] {
  const normalize = (p: Project): Project => ({
    ...p,
    contractValue: Number(p.contractValue) || 0,
    estimatedCost: Number(p.estimatedCost) || 0,
  });

  // Only an ABSENT store means "first run" and gets the seed. An explicitly
  // empty list is a real state — otherwise deleting the last project silently
  // brought the seed back and the delete looked broken.
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(PROJECTS_KEY);
  } catch {
    raw = null;
  }
  if (raw === null) {
    const seeded = SEED_PROJECTS.map(normalize);
    writeJSON(PROJECTS_KEY, seeded);
    return seeded;
  }

  let stored: Project[] = [];
  try {
    stored = JSON.parse(raw) as Project[];
  } catch {
    return SEED_PROJECTS.map(normalize);
  }
  if (!Array.isArray(stored)) return SEED_PROJECTS.map(normalize);
  return stored
    .filter((p) => p && typeof p.id === 'string' && p.id.trim() !== '')
    .map(normalize);
}

export function saveProjects(list: Project[]) {
  writeJSON(PROJECTS_KEY, list);
  emitChange();
}

export function projectNameOf(id: string): string {
  const key = String(id || '').trim();
  if (!key) return '';
  const upper = key.toUpperCase();
  return loadProjects().find((p) => p.id.toUpperCase() === upper)?.name || key;
}

export function upsertProject(project: Project): Project {
  const id = String(project.id || '').trim().toUpperCase();
  if (!id) throw new Error('A project/job number is required.');
  const next: Project = {
    id,
    name: String(project.name || id).trim() || id,
    client: String(project.client || '').trim(),
    status: project.status || 'active',
    startDate: project.startDate || '',
    endDate: project.endDate || '',
    contractValue: Math.max(0, Number(project.contractValue) || 0),
    estimatedCost: Math.max(0, Number(project.estimatedCost) || 0),
  };
  const list = loadProjects().filter((p) => p.id !== id);
  saveProjects([...list, next].sort((a, b) => a.id.localeCompare(b.id)));
  return next;
}

export function removeProject(id: string) {
  const key = String(id || '').trim().toUpperCase();
  const remaining = loadProjects().filter((p) => p.id !== key);
  saveProjects(remaining);
  // Deleting the open job must not leave the app pointing at a job that no
  // longer exists: every scoped screen would read an abandoned key set.
  if (key && getActiveProject() === key) {
    setActiveProject(remaining[0]?.id || DEFAULT_PROJECT_ID);
  }
}

/** Find-or-create a project for a posting. Never rejects a valid id. */
export function ensureProject(id: string, name?: string): Project | null {
  const key = String(id || '').trim().toUpperCase();
  if (!key) return null;
  const existing = loadProjects().find((p) => p.id === key);
  if (existing) return existing;
  return upsertProject({ id: key, name: name || key, client: '', status: 'active', startDate: '', endDate: '' });
}

// ---------------------------------------------------------------------------
// Cost codes
// ---------------------------------------------------------------------------
export function loadCostCodes(): CostCode[] {
  // Seeds are a first-run default only. An explicitly empty list is a real
  // state: deleting the last cost code must not silently bring 15 back.
  const seeded = () => SEED_COST_CODES.map((c) => ({ ...c }));
  const stored = readScoped<unknown>(COST_CODES_KEY, null);
  if (!Array.isArray(stored)) return seeded();
  return (stored as CostCode[]).filter((c) => c && typeof c.code === 'string' && c.code.trim() !== '');
}

export function saveCostCodes(list: CostCode[]) {
  // Cost codes belong to the job's costing structure, so a job with a
  // different trade breakdown is not forced to reuse another company's codes.
  writeScoped(COST_CODES_KEY, list);
  emitChange();
}

function nextCode(codes: CostCode[]): string {
  const max = codes.reduce((m, c) => Math.max(m, Number(c.code) || 0), 0);
  return String(Math.ceil((max + 100) / 100) * 100).padStart(4, '0');
}

/** Resolve a stored category (name) or a code to its master row. */
export function costCodeOf(value: string): CostCode | null {
  const key = String(value || '').trim();
  if (!key) return null;
  const codes = loadCostCodes();
  return (
    codes.find((c) => c.code === key) ||
    codes.find((c) => c.name.toLowerCase() === key.toLowerCase()) ||
    null
  );
}

export function costCodeName(value: string): string {
  const key = String(value || '').trim();
  if (!key) return '';
  return costCodeOf(key)?.name || key;
}

export function upsertCostCode(input: { code: string; name: string; kind?: CostCodeKind }): CostCode {
  const name = String(input.name || '').trim();
  const code = String(input.code || '').trim().toUpperCase();
  if (!name) throw new Error('A cost code name is required.');
  if (!code) throw new Error('A cost code number is required.');
  if (!/^[A-Z0-9][A-Z0-9._-]{0,15}$/.test(code)) throw new Error('Cost code numbers may use letters, digits, dot, dash or underscore.');
  const entry: CostCode = { code, name, kind: input.kind || (isLabourCategory(name) ? 'labour' : 'other') };
  const list = loadCostCodes().filter((c) => c.code !== code && c.name.toLowerCase() !== name.toLowerCase());
  saveCostCodes([...list, entry].sort((a, b) => a.code.localeCompare(b.code)));
  return entry;
}

export function removeCostCode(code: string) {
  saveCostCodes(loadCostCodes().filter((c) => c.code !== code));
}

/** Find-or-create a cost code for a posting's category name. */
export function ensureCostCode(name: string): CostCode | null {
  const key = String(name || '').trim();
  if (!key) return null;
  const existing = costCodeOf(key);
  if (existing) return existing;
  const codes = loadCostCodes();
  return upsertCostCode({ code: nextCode(codes), name: key });
}

// ---------------------------------------------------------------------------
// BOQ reads used by job costing (budgets) and the entry form (item picker)
// ---------------------------------------------------------------------------
export interface BoqItemRef {
  itemCode: string;
  description: string;
  unit: string;
  amount: number;
  costCode: string;
  /** Contract quantity and rate, so a running bill can pre-load the line. */
  qty: number;
  rate: number;
}

/** Contract value of a job: master value, else the BOQ total for the BOQ project. */
export function contractValueOf(id: string): number {
  const key = String(id || '').trim().toUpperCase();
  const project = loadProjects().find((p) => p.id.toUpperCase() === key);
  const declared = Number(project?.contractValue) || 0;
  if (declared > 0) return round2(declared);
  return boqTotal(key);
}

/** Estimated total cost at completion (the % complete denominator). */
export function estimatedCostOf(id: string): number {
  const key = String(id || '').trim().toUpperCase();
  return round2(Number(loadProjects().find((p) => p.id.toUpperCase() === key)?.estimatedCost) || 0);
}

/** Contract value implied by the BOQ: Σ item quantity × bidder's rate. */
export function boqTotal(projectId: string = getActiveProject()): number {
  return round2(loadBoqItems(projectId).reduce((sum, item) => sum + item.amount, 0));
}

/** Items of ONE project's BOQ (defaults to the active project). */
export function loadBoqItems(projectId: string = getActiveProject()): BoqItemRef[] {
  const boq = readScoped<any[]>(BOQ_KEY, [], projectId);
  const out: BoqItemRef[] = [];
  for (const section of boq || []) {
    for (const item of section?.children || []) {
      if (!item?.itemCode) continue;
      // Rows imported before `amount` was stored still price correctly.
      const storedAmount = Number(item.amount);
      out.push({
        itemCode: String(item.itemCode),
        description: String(item.description || ''),
        unit: String(item.unit || ''),
        amount: Number.isFinite(storedAmount)
          ? round2(storedAmount)
          : round2((Number(item.estimatedQuantity) || 0) * (Number(item.rate) || 0)),
        costCode: String(item.costCode || ''),
        qty: round2(item.estimatedQuantity),
        rate: round2(item.rate),
      });
    }
  }
  return out;
}
