// ============================================================================
// statementsService — P&L, balance sheet and project P&L from the posted ledger.
//
// Nothing here stores anything: every figure is derived from entry_lines, so a
// statement can never disagree with the books. What this module adds is the
// CONSTRUCTION reading of those lines:
//
//   • VAT is never revenue or cost — input sits in an asset, output in a
//     liability, exactly where it was posted.
//   • Retention is an asset (receivable withheld), not a reduction of revenue.
//   • Cost splits into DIRECT cost (lines carrying a job) and OVERHEAD (lines
//     with no job), then direct cost rolls up by cost-code kind — materials,
//     labour, subcontract, plant — which is how a contractor reads margin.
//   • Worker accounts are per-worker running balances: a debit balance is an
//     advance (asset), a credit balance is wages owed (liability).
//   • Equity carries retained earnings brought forward plus profit for the
//     period, so assets = liabilities + equity always, and a difference means
//     an account could not be classified (listed, never hidden).
//
// Comparatives are the immediately preceding window of equal length, so a
// month is read against the month before and a fiscal year-to-date against the
// same span of the previous year — one glance tells you which way margin moved.
// ============================================================================
import { allEntries, allLines, jobCost, loadAccounts, wipReport, type AccountKind } from './booksService';
import { BS_MONTHS } from '../utils/nepaliDate';
import { fiscalYearOf, periodAdRange } from './periods';
import { costCodeOf, loadProjects, projectNameOf, contractValueOf, estimatedCostOf } from './masterData';

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export type StatementScope = 'month' | 'fytd';

export interface StatementWindow {
  scope: StatementScope;
  from: string; // AD, inclusive
  to: string; // AD, inclusive
  priorFrom: string;
  priorTo: string;
  label: string;
  priorLabel: string;
  months: number; // B.S. months covered by the window
}

const monthLabel = (y: number, m: number) => `${BS_MONTHS[m - 1]} ${y}`;

function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const zero = year * 12 + (month - 1) + delta;
  const y = Math.floor(zero / 12);
  return { year: y, month: zero - y * 12 + 1 };
}

function monthsBetween(a: { year: number; month: number }, b: { year: number; month: number }): number {
  return b.year * 12 + b.month - (a.year * 12 + a.month);
}

/**
 * The window a statement is read over: one B.S. month, or the fiscal year to
 * the end of the selected month. The comparative is always the same length.
 */
export function statementWindow(year: number, month: number, scope: StatementScope): StatementWindow {
  const fy = fiscalYearOf(year, month);
  const start = scope === 'month' ? { year, month } : { year: fy.startYear, month: fy.startMonth };
  const months = monthsBetween(start, { year, month }) + 1;

  const { from } = periodAdRange({ year: start.year, month: start.month });
  const { to } = periodAdRange({ year, month });

  const priorStart = shiftMonth(start.year, start.month, -months);
  const priorEnd = shiftMonth(start.year, start.month, -1);
  const { from: priorFrom } = periodAdRange(priorStart);
  const { to: priorTo } = periodAdRange(priorEnd);

  const label = scope === 'month' ? monthLabel(year, month) : `${monthLabel(start.year, start.month)} → ${monthLabel(year, month)}`;
  const priorLabel =
    scope === 'month' ? monthLabel(priorStart.year, priorStart.month) : `${monthLabel(priorStart.year, priorStart.month)} → ${monthLabel(priorEnd.year, priorEnd.month)}`;

  return { scope, from, to, priorFrom, priorTo, label, priorLabel, months };
}

// ---------------------------------------------------------------------------
// Ledger access
// ---------------------------------------------------------------------------
interface DatedLine {
  account_id: string;
  party_id: string;
  project_id: string;
  cost_code: string;
  debit: number;
  credit: number;
  date: string;
}

function datedLines(from?: string, to?: string): DatedLine[] {
  const entries = new Map(allEntries().map((e) => [e.id, e] as const));
  const out: DatedLine[] = [];
  for (const l of allLines()) {
    const e = entries.get(l.entry_id);
    if (!e) continue;
    if (from && e.ad_date < from) continue;
    if (to && e.ad_date > to) continue;
    out.push({
      account_id: l.account_id,
      party_id: l.party_id,
      project_id: l.project_id,
      cost_code: l.cost_code,
      debit: l.debit,
      credit: l.credit,
      date: e.ad_date,
    });
  }
  return out;
}

function kindMap(): Map<string, AccountKind> {
  return new Map(loadAccounts().map((a) => [a.id, a.kind] as const));
}

function nameMap(): Map<string, string> {
  return new Map(loadAccounts().map((a) => [a.id, a.name] as const));
}

const OVERHEAD_PROJECTS = new Set(['', 'overhead', 'general']);
const isDirect = (projectId: string) => !OVERHEAD_PROJECTS.has(String(projectId || '').trim().toLowerCase()) && String(projectId || '').trim() !== '';

// ---------------------------------------------------------------------------
// Profit & loss
// ---------------------------------------------------------------------------
export const DIRECT_COST_GROUPS: { key: string; label: string }[] = [
  { key: 'material', label: 'Materials' },
  { key: 'labour', label: 'Site labour' },
  { key: 'subcontract', label: 'Subcontractors' },
  { key: 'equipment', label: 'Plant & equipment' },
  { key: 'other', label: 'Other direct cost' },
];

function costGroupOf(costCode: string): { key: string; label: string } {
  const kind = costCodeOf(costCode)?.kind || 'other';
  return DIRECT_COST_GROUPS.find((g) => g.key === kind) || DIRECT_COST_GROUPS[DIRECT_COST_GROUPS.length - 1];
}

interface Buckets {
  revenue: Map<string, number>;
  direct: Map<string, number>;
  overhead: Map<string, number>;
  unclassified: Map<string, number>;
}

function pnlBuckets(from: string, to: string): Buckets {
  const kinds = kindMap();
  const names = nameMap();
  const b: Buckets = { revenue: new Map(), direct: new Map(), overhead: new Map(), unclassified: new Map() };
  const add = (map: Map<string, number>, key: string, amount: number) => map.set(key, round2((map.get(key) || 0) + amount));

  for (const l of datedLines(from, to)) {
    const kind = kinds.get(l.account_id);
    if (kind === 'income') {
      add(b.revenue, names.get(l.account_id) || l.account_id, l.credit - l.debit);
      continue;
    }
    if (kind === 'expense') {
      const net = round2(l.debit - l.credit);
      if (net === 0) continue;
      if (isDirect(l.project_id)) add(b.direct, costGroupOf(l.cost_code).key, net);
      else add(b.overhead, names.get(l.account_id) || l.account_id, net);
      continue;
    }
    // A line on an account whose kind nobody set would otherwise vanish from
    // both statements and quietly break the tie-out: surface it instead.
    if (!kind && (l.debit || l.credit)) add(b.unclassified, names.get(l.account_id) || l.account_id, l.debit - l.credit);
  }
  return b;
}

export interface PnlRow {
  key: string;
  label: string;
  amount: number;
  prior: number;
}

export interface ProfitAndLoss {
  window: StatementWindow;
  revenue: PnlRow[];
  revenueTotal: number;
  revenuePrior: number;
  directCost: PnlRow[];
  directCostTotal: number;
  directCostPrior: number;
  grossProfit: number;
  grossProfitPrior: number;
  grossMargin: number;
  grossMarginPrior: number;
  overheads: PnlRow[];
  overheadTotal: number;
  overheadPrior: number;
  netProfit: number;
  netProfitPrior: number;
  netMargin: number;
  netMarginPrior: number;
  unclassified: PnlRow[];
}

function rowsFrom(current: Map<string, number>, prior: Map<string, number>, labelOf: (key: string, i: number) => string): PnlRow[] {
  const keys = new Set([...current.keys(), ...prior.keys()]);
  return [...keys]
    .map((key, i) => ({
      key,
      label: labelOf(key, i),
      amount: round2(current.get(key) || 0),
      prior: round2(prior.get(key) || 0),
    }))
    .filter((r) => r.amount !== 0 || r.prior !== 0)
    .sort((a, b) => b.amount - a.amount);
}

const total = (rows: PnlRow[], field: 'amount' | 'prior') => round2(rows.reduce((s, r) => s + r[field], 0));
/** Margin as a percentage, one decimal — what a contractor reads on a job. */
const ratio = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

export function profitAndLoss(window: StatementWindow): ProfitAndLoss {
  const cur = pnlBuckets(window.from, window.to);
  const prev = pnlBuckets(window.priorFrom, window.priorTo);

  const revenue = rowsFrom(cur.revenue, prev.revenue, (k) => k);
  const directCost = rowsFrom(cur.direct, prev.direct, (k) => DIRECT_COST_GROUPS.find((g) => g.key === k)?.label || k)
    .sort((a, b) => DIRECT_COST_GROUPS.findIndex((g) => g.key === a.key) - DIRECT_COST_GROUPS.findIndex((g) => g.key === b.key));
  const overheads = rowsFrom(cur.overhead, prev.overhead, (k) => k);
  const unclassified = rowsFrom(cur.unclassified, prev.unclassified, (k) => k);

  const revenueTotal = total(revenue, 'amount');
  const revenuePrior = total(revenue, 'prior');
  const directCostTotal = total(directCost, 'amount');
  const directCostPrior = total(directCost, 'prior');
  const overheadTotal = total(overheads, 'amount');
  const overheadPrior = total(overheads, 'prior');

  const grossProfit = round2(revenueTotal - directCostTotal);
  const grossProfitPrior = round2(revenuePrior - directCostPrior);
  const netProfit = round2(grossProfit - overheadTotal);
  const netProfitPrior = round2(grossProfitPrior - overheadPrior);

  return {
    window,
    revenue,
    revenueTotal,
    revenuePrior,
    directCost,
    directCostTotal,
    directCostPrior,
    grossProfit,
    grossProfitPrior,
    grossMargin: ratio(grossProfit, revenueTotal),
    grossMarginPrior: ratio(grossProfitPrior, revenuePrior),
    overheads,
    overheadTotal,
    overheadPrior,
    netProfit,
    netProfitPrior,
    netMargin: ratio(netProfit, revenueTotal),
    netMarginPrior: ratio(netProfitPrior, revenuePrior),
    unclassified,
  };
}

// ---------------------------------------------------------------------------
// Balance sheet
// ---------------------------------------------------------------------------
export interface BsRow {
  account_id: string;
  name: string;
  amount: number;
  prior: number;
}

export interface BsSection {
  key: string;
  label: string;
  rows: BsRow[];
  total: number;
  totalPrior: number;
}

interface Nets {
  dr: Map<string, number>;
  cr: Map<string, number>;
}

function netsTo(to: string): Nets {
  const dr = new Map<string, number>();
  const cr = new Map<string, number>();
  for (const l of datedLines(undefined, to)) {
    dr.set(l.account_id, round2((dr.get(l.account_id) || 0) + l.debit));
    cr.set(l.account_id, round2((cr.get(l.account_id) || 0) + l.credit));
  }
  return { dr, cr };
}

/** Net profit (income − expense) strictly before `date`. */
function profitBefore(date: string): number {
  const kinds = kindMap();
  let net = 0;
  for (const l of datedLines(undefined, date)) {
    const kind = kinds.get(l.account_id);
    if (kind === 'income') net += l.credit - l.debit;
    else if (kind === 'expense') net -= l.debit - l.credit;
  }
  return round2(net);
}

const ASSET_GROUPS: { kinds: AccountKind[]; label: string }[] = [
  { kinds: ['cash', 'bank'], label: 'Cash & bank' },
  { kinds: ['receivable'], label: 'Receivables' },
  { kinds: ['asset'], label: 'Inventory & other assets' },
];
const LIABILITY_GROUPS: { kinds: AccountKind[]; label: string }[] = [
  { kinds: ['payable'], label: 'Payables' },
  { kinds: ['liability'], label: 'Statutory & borrowings' },
];

export interface BalanceSheet {
  window: StatementWindow;
  asOf: string;
  asOfPrior: string;
  assets: BsSection[];
  liabilities: BsSection[];
  equity: BsSection[];
  retainedBroughtForward: number;
  retainedBroughtForwardPrior: number;
  profitForPeriod: number;
  profitForPeriodPrior: number;
  totalAssets: number;
  totalAssetsPrior: number;
  totalLiabilities: number;
  totalLiabilitiesPrior: number;
  totalEquity: number;
  totalEquityPrior: number;
  totalLiabilitiesAndEquity: number;
  totalLiabilitiesAndEquityPrior: number;
  difference: number;
  differencePrior: number;
  balanced: boolean;
  unclassified: BsRow[];
}

function section(key: string, label: string, rows: BsRow[]): BsSection {
  return {
    key,
    label,
    rows,
    total: round2(rows.reduce((s, r) => s + r.amount, 0)),
    totalPrior: round2(rows.reduce((s, r) => s + r.prior, 0)),
  };
}

export function balanceSheet(window: StatementWindow): BalanceSheet {
  const kinds = kindMap();
  const names = nameMap();
  const cur = netsTo(window.to);
  const prev = netsTo(window.priorTo);

  // Every account that carries a balance at either date.
  const ids = new Set<string>([...cur.dr.keys(), ...cur.cr.keys(), ...prev.dr.keys(), ...prev.cr.keys()]);

  const assetBuckets = new Map<string, BsRow[]>();
  const liabilityBuckets = new Map<string, BsRow[]>();
  const equityRows: BsRow[] = [];
  const unclassified: BsRow[] = [];

  for (const id of ids) {
    const kind = kinds.get(id);
    const debit = round2((cur.dr.get(id) || 0) - (cur.cr.get(id) || 0));
    const priorDebit = round2((prev.dr.get(id) || 0) - (prev.cr.get(id) || 0));
    if (!kind) {
      if (debit !== 0 || priorDebit !== 0) unclassified.push({ account_id: id, name: names.get(id) || id, amount: debit, prior: priorDebit });
      continue;
    }
    // Income and expense accounts do not sit on the balance sheet: they roll
    // into retained earnings below.
    if (kind === 'income' || kind === 'expense') continue;

    const row: BsRow = { account_id: id, name: names.get(id) || id, amount: 0, prior: 0 };
    const push = (bucket: Map<string, BsRow[]>, groupKey: string, amount: number, prior: number) => {
      const list = bucket.get(groupKey) || [];
      list.push({ ...row, amount, prior });
      bucket.set(groupKey, list);
    };

    if (kind === 'worker') {
      // A worker balance is an advance when the books owe them nothing yet…
      if (debit > 0 || priorDebit > 0) push(assetBuckets, 'Worker advances', debit, priorDebit);
      else if (debit < 0 || priorDebit < 0) push(liabilityBuckets, 'Worker payable', round2(-debit), round2(-priorDebit));
      else push(liabilityBuckets, 'Worker payable', 0, 0);
      continue;
    }
    if (kind === 'equity') {
      equityRows.push({ ...row, amount: round2(-debit), prior: round2(-priorDebit) });
      continue;
    }
    const assetGroup = ASSET_GROUPS.find((g) => g.kinds.includes(kind));
    if (assetGroup) {
      push(assetBuckets, assetGroup.label, debit, priorDebit);
      continue;
    }
    const liabilityGroup = LIABILITY_GROUPS.find((g) => g.kinds.includes(kind));
    if (liabilityGroup) {
      push(liabilityBuckets, liabilityGroup.label, round2(-debit), round2(-priorDebit));
      continue;
    }
    unclassified.push({ ...row, amount: debit, prior: priorDebit });
  }

  const sortedRows = (rows: BsRow[]) => rows.filter((r) => r.amount !== 0 || r.prior !== 0).sort((a, b) => a.name.localeCompare(b.name));
  const buildSections = (bucket: Map<string, BsRow[]>, order: string[]) =>
    order
      .map((label) => section(label.toLowerCase().replace(/[^a-z]+/g, '-'), label, sortedRows(bucket.get(label) || [])))
      .filter((s) => s.rows.length > 0);

  const assetOrder = [...ASSET_GROUPS.map((g) => g.label), 'Worker advances'];
  const liabilityOrder = [...LIABILITY_GROUPS.map((g) => g.label), 'Worker payable'];

  const retainedBroughtForward = profitBefore(window.from);
  const profitForPeriod = round2(profitAndLoss(window).netProfit);
  const retainedBroughtForwardPrior = profitBefore(window.priorFrom);
  const profitForPeriodPrior = round2(profitAndLoss({ ...window, from: window.priorFrom, to: window.priorTo }).netProfit);

  const assets = buildSections(assetBuckets, assetOrder);
  const liabilities = buildSections(liabilityBuckets, liabilityOrder);
  const equity = [
    ...(sortedRows(equityRows).length ? [section('capital', 'Capital', sortedRows(equityRows))] : []),
    section('retained-earnings', 'Retained earnings', [
      { account_id: 'acc:retained-bf', name: 'Brought forward', amount: retainedBroughtForward, prior: retainedBroughtForwardPrior },
      { account_id: 'acc:retained-period', name: 'Profit for the period', amount: profitForPeriod, prior: profitForPeriodPrior },
    ]),
  ].filter((s) => s.rows.length > 0);

  const sum = (sections: BsSection[], field: 'total' | 'totalPrior') => round2(sections.reduce((s, x) => s + x[field], 0));

  const totalAssets = sum(assets, 'total');
  const totalAssetsPrior = sum(assets, 'totalPrior');
  const totalLiabilities = sum(liabilities, 'total');
  const totalLiabilitiesPrior = sum(liabilities, 'totalPrior');
  const totalEquity = sum(equity, 'total');
  const totalEquityPrior = sum(equity, 'totalPrior');
  const totalLiabilitiesAndEquity = round2(totalLiabilities + totalEquity);
  const totalLiabilitiesAndEquityPrior = round2(totalLiabilitiesPrior + totalEquityPrior);
  const difference = round2(totalAssets - totalLiabilitiesAndEquity);

  return {
    window,
    asOf: window.to,
    asOfPrior: window.priorTo,
    assets,
    liabilities,
    equity,
    retainedBroughtForward,
    retainedBroughtForwardPrior,
    profitForPeriod,
    profitForPeriodPrior,
    totalAssets,
    totalAssetsPrior,
    totalLiabilities,
    totalLiabilitiesPrior,
    totalEquity,
    totalEquityPrior,
    totalLiabilitiesAndEquity,
    totalLiabilitiesAndEquityPrior,
    difference,
    differencePrior: round2(totalAssetsPrior - totalLiabilitiesAndEquityPrior),
    balanced: Math.abs(difference) < 0.005,
    unclassified,
  };
}

// ---------------------------------------------------------------------------
// Project P&L — the job's own margin, next to what has been billed and earned
// ---------------------------------------------------------------------------
export interface ProjectPnlRow {
  project_id: string;
  name: string;
  contractValue: number;
  revenue: number;
  revenuePrior: number;
  cost: number;
  costPrior: number;
  grossProfit: number;
  grossProfitPrior: number;
  margin: number;
  marginPrior: number;
  costByKind: { key: string; label: string; amount: number }[];
  // Position to date (not window-limited) — how the job is doing overall.
  earnedRevenue: number;
  pctComplete: number;
  billedToDate: number;
  overUnder: number;
  budgetCost: number;
  forecastCost: number;
}

export interface ProjectPnl {
  window: StatementWindow;
  rows: ProjectPnlRow[];
  totals: {
    revenue: number;
    revenuePrior: number;
    cost: number;
    costPrior: number;
    grossProfit: number;
    grossProfitPrior: number;
    margin: number;
  };
}

function projectBuckets(from: string, to: string) {
  const kinds = kindMap();
  const map = new Map<string, { revenue: number; cost: number; byKind: Map<string, number> }>();
  const row = (id: string) => {
    if (!map.has(id)) map.set(id, { revenue: 0, cost: 0, byKind: new Map() });
    return map.get(id)!;
  };
  for (const l of datedLines(from, to)) {
    const projectId = String(l.project_id || '').trim();
    if (OVERHEAD_PROJECTS.has(projectId.toLowerCase())) continue;
    const kind = kinds.get(l.account_id);
    if (kind === 'income') {
      const r = row(projectId);
      r.revenue = round2(r.revenue + l.credit - l.debit);
    } else if (kind === 'expense') {
      const r = row(projectId);
      const net = round2(l.debit - l.credit);
      const group = costGroupOf(l.cost_code);
      r.cost = round2(r.cost + net);
      r.byKind.set(group.key, round2((r.byKind.get(group.key) || 0) + net));
    }
  }
  return map;
}

export function projectPnl(window: StatementWindow): ProjectPnl {
  const cur = projectBuckets(window.from, window.to);
  const prev = projectBuckets(window.priorFrom, window.priorTo);
  const wip = wipReport(window.to);
  const wipById = new Map(wip.rows.map((r) => [r.project_id, r] as const));
  const jobs = new Map(jobCost().map((r) => [r.project_id, r] as const));

  const ids = new Set<string>([...cur.keys(), ...prev.keys()]);
  // A mastered job belongs on the schedule even before it has activity.
  for (const p of loadProjects()) if ((Number(p.contractValue) || 0) > 0) ids.add(p.id);

  const rows: ProjectPnlRow[] = [...ids]
    .filter(Boolean)
    .map((projectId) => {
      const c = cur.get(projectId) || { revenue: 0, cost: 0, byKind: new Map<string, number>() };
      const p = prev.get(projectId) || { revenue: 0, cost: 0, byKind: new Map<string, number>() };
      const w = wipById.get(projectId);
      const grossProfit = round2(c.revenue - c.cost);
      const grossProfitPrior = round2(p.revenue - p.cost);
      return {
        project_id: projectId,
        name: projectNameOf(projectId) || projectId,
        contractValue: contractValueOf(projectId),
        revenue: round2(c.revenue),
        revenuePrior: round2(p.revenue),
        cost: round2(c.cost),
        costPrior: round2(p.cost),
        grossProfit,
        grossProfitPrior,
        margin: ratio(grossProfit, c.revenue),
        marginPrior: ratio(grossProfitPrior, p.revenue),
        costByKind: DIRECT_COST_GROUPS.map((g) => ({ key: g.key, label: g.label, amount: round2(c.byKind.get(g.key) || 0) })).filter(
          (r) => r.amount !== 0
        ),
        earnedRevenue: round2(w?.earnedRevenue || 0),
        pctComplete: w?.pctComplete || 0,
        billedToDate: round2(w?.billings || 0),
        overUnder: round2(w?.overUnder || 0),
        budgetCost: estimatedCostOf(projectId) || round2(jobs.get(projectId)?.budget || 0),
        forecastCost: round2(jobs.get(projectId)?.forecast || w?.costToDate || 0),
      };
    })
    .filter((r) => r.revenue !== 0 || r.cost !== 0 || r.revenuePrior !== 0 || r.costPrior !== 0 || r.budgetCost > 0)
    .sort((a, b) => b.grossProfit - a.grossProfit || a.project_id.localeCompare(b.project_id));

  const revenue = round2(rows.reduce((s, r) => s + r.revenue, 0));
  const cost = round2(rows.reduce((s, r) => s + r.cost, 0));
  const revenuePrior = round2(rows.reduce((s, r) => s + r.revenuePrior, 0));
  const costPrior = round2(rows.reduce((s, r) => s + r.costPrior, 0));

  return {
    window,
    rows,
    totals: {
      revenue,
      revenuePrior,
      cost,
      costPrior,
      grossProfit: round2(revenue - cost),
      grossProfitPrior: round2(revenuePrior - costPrior),
      margin: ratio(round2(revenue - cost), revenue),
    },
  };
}
