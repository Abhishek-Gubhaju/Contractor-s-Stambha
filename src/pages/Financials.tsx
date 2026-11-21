// ============================================================================
// Financials — P&L, balance sheet and project P&L, read straight off the ledger.
//
// Nothing is exported or re-keyed: switch the month and every figure recomputes
// from entry_lines. Comparatives are the immediately preceding window of equal
// length, so a month reads against the month before and a fiscal year-to-date
// against the same span last year.
//
// The balance sheet shows its own tie-out: assets vs liabilities + equity. A
// difference is never hidden — it names the accounts that could not be
// classified, because that is the only way it can happen.
// ============================================================================
import { useEffect, useMemo, useState } from 'react';
import { Scale, TrendingUp, Building2 } from 'lucide-react';
import { Tabs } from '../components/ui';
import { TabsList, TabsTrigger, TabsContent } from '../components/ui/Tabs';
import { formatCurrency, cn } from '../utils';
import { BS_MONTHS, getTodayBS } from '../utils/nepaliDate';
import {
  statementWindow,
  profitAndLoss,
  balanceSheet,
  projectPnl,
  type StatementScope,
} from '../services/statementsService';

const fmt = (n: number) => formatCurrency(n);
const pct = (n: number) => `${(Math.round(n * 10) / 10).toFixed(1)}%`;
const change = (cur: number, prior: number) => Math.round((cur - prior) * 100) / 100;

function Line({
  label,
  amount,
  prior,
  bold,
  indent,
  tone,
  testId,
}: {
  label: string;
  amount: number;
  prior?: number;
  bold?: boolean;
  indent?: boolean;
  tone?: 'positive' | 'negative';
  testId?: string;
}) {
  return (
    <tr className={cn(bold && 'bg-gray-50 font-semibold')} data-testid={testId}>
      <td className={cn('py-1.5 pr-4', indent && 'pl-4', bold ? 'text-gray-900' : 'text-gray-700')}>{label}</td>
      <td className={cn('py-1.5 px-4 text-right tabular-nums', tone === 'positive' && 'text-emerald-700', tone === 'negative' && 'text-rose-700')}>
        {fmt(amount)}
      </td>
      {prior !== undefined && <td className="py-1.5 px-4 text-right tabular-nums text-gray-500">{fmt(prior)}</td>}
      {prior !== undefined && (
        <td className={cn('py-1.5 pl-4 text-right tabular-nums', amount - prior > 0 ? 'text-emerald-700' : amount - prior < 0 ? 'text-rose-700' : 'text-gray-400')}>
          {amount - prior === 0 ? '—' : fmt(Math.abs(change(amount, prior)))}
        </td>
      )}
    </tr>
  );
}

function TableHead({ periods }: { periods: [string, string] }) {
  return (
    <thead className="text-[11px] uppercase tracking-wide text-gray-500 border-b border-gray-200">
      <tr>
        <th className="py-2 pr-4 text-left"></th>
        <th className="py-2 px-4 text-right">{periods[0]}</th>
        <th className="py-2 px-4 text-right">{periods[1]}</th>
        <th className="py-2 pl-4 text-right">Change</th>
      </tr>
    </thead>
  );
}

export default function FinancialsPage() {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    for (const name of ['contractoros:books-changed', 'contractoros:project-changed', 'contractoros:masters-changed']) {
      window.addEventListener(name, bump);
    }
    return () => {
      for (const name of ['contractoros:books-changed', 'contractoros:project-changed', 'contractoros:masters-changed']) {
        window.removeEventListener(name, bump);
      }
    };
  }, []);

  const today = getTodayBS();
  const [year, setYear] = useState(today.year);
  const [month, setMonth] = useState(today.month);
  const [scope, setScope] = useState<StatementScope>('fytd');

  const period = useMemo(() => statementWindow(year, month, scope), [year, month, scope]);
  const pnl = useMemo(() => profitAndLoss(period), [period, version]);
  const bs = useMemo(() => balanceSheet(period), [period, version]);
  const jobs = useMemo(() => projectPnl(period), [period, version]);

  const years = useMemo(() => {
    const list: number[] = [];
    for (let y = today.year - 3; y <= today.year + 1; y++) list.push(y);
    return list;
  }, [today.year]);

  const priorPeriods: [string, string] = [period.label, period.priorLabel];

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1>Financials</h1>
          <p className="text-sm text-gray-500">Profit &amp; loss, financial position and job margins — read from the posted ledger.</p>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="text-[11px] text-gray-500">
            B.S. year
            <select
              className="mt-0.5 block border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm bg-white"
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              aria-label="B.S. year"
            >
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
          <label className="text-[11px] text-gray-500">
            Month
            <select
              className="mt-0.5 block border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm bg-white"
              value={month}
              onChange={(e) => setMonth(Number(e.target.value))}
              aria-label="B.S. month"
            >
              {BS_MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </label>
          <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
            {([['month', 'This month'], ['fytd', 'Fiscal year to date']] as [StatementScope, string][]).map(([value, label]) => (
              <button
                key={value}
                type="button"
                data-testid={`scope-${value}`}
                onClick={() => setScope(value)}
                className={cn('px-3 py-1.5', scope === value ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50')}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <p className="text-xs text-gray-500">
        {period.label} · AD {period.from} → {period.to} · compared with {period.priorLabel} (AD {period.priorFrom} → {period.priorTo})
      </p>

      <Tabs defaultValue="pnl">
        <TabsList>
          <TabsTrigger value="pnl"><TrendingUp className="w-3.5 h-3.5 mr-1" /> Profit &amp; Loss</TabsTrigger>
          <TabsTrigger value="bs"><Scale className="w-3.5 h-3.5 mr-1" /> Balance Sheet</TabsTrigger>
          <TabsTrigger value="projects"><Building2 className="w-3.5 h-3.5 mr-1" /> Project P&amp;L</TabsTrigger>
        </TabsList>

        {/* ---------------- P&L ---------------- */}
        <TabsContent value="pnl" className="pt-4">
          <div className="bg-white rounded-xl border p-5">
            <table className="w-full text-sm" data-testid="pnl-table">
              <TableHead periods={priorPeriods} />
              <tbody>
                <tr><td colSpan={4} className="pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Revenue</td></tr>
                {pnl.revenue.length === 0 && <Line label="No revenue posted in this period" amount={0} prior={0} indent />}
                {pnl.revenue.map((r) => <Line key={r.key} label={r.label} amount={r.amount} prior={r.prior} indent />)}
                <Line label="Total revenue" amount={pnl.revenueTotal} prior={pnl.revenuePrior} bold testId="pnl-revenue" />

                <tr><td colSpan={4} className="pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Direct cost (job cost)</td></tr>
                {pnl.directCost.length === 0 && <Line label="No job cost posted in this period" amount={0} prior={0} indent />}
                {pnl.directCost.map((r) => <Line key={r.key} label={r.label} amount={r.amount} prior={r.prior} indent />)}
                <Line label="Total direct cost" amount={pnl.directCostTotal} prior={pnl.directCostPrior} bold tone="negative" />

                <Line label="Gross profit" amount={pnl.grossProfit} prior={pnl.grossProfitPrior} bold testId="pnl-gross" />
                <tr>
                  <td className="py-1 pl-4 text-xs text-gray-500">Gross margin</td>
                  <td className="py-1 px-4 text-right text-xs tabular-nums text-gray-600">{pct(pnl.grossMargin)}</td>
                  <td className="py-1 px-4 text-right text-xs tabular-nums text-gray-500">{pct(pnl.grossMarginPrior)}</td>
                  <td className="py-1 pl-4 text-right text-xs text-gray-400">{(pnl.grossMargin - pnl.grossMarginPrior).toFixed(1)} pts</td>
                </tr>

                <tr><td colSpan={4} className="pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Overheads (no job)</td></tr>
                {pnl.overheads.length === 0 && <Line label="No overhead posted in this period" amount={0} prior={0} indent />}
                {pnl.overheads.map((r) => <Line key={r.key} label={r.label} amount={r.amount} prior={r.prior} indent />)}
                <Line label="Total overheads" amount={pnl.overheadTotal} prior={pnl.overheadPrior} bold tone="negative" />

                <Line label="Net profit" amount={pnl.netProfit} prior={pnl.netProfitPrior} bold testId="pnl-net" tone={pnl.netProfit >= 0 ? 'positive' : 'negative'} />
                <tr>
                  <td className="py-1 pl-4 text-xs text-gray-500">Net margin</td>
                  <td className="py-1 px-4 text-right text-xs tabular-nums text-gray-600">{pct(pnl.netMargin)}</td>
                  <td className="py-1 px-4 text-right text-xs tabular-nums text-gray-500">{pct(pnl.netMarginPrior)}</td>
                  <td className="py-1 pl-4 text-right text-xs text-gray-400">{(pnl.netMargin - pnl.netMarginPrior).toFixed(1)} pts</td>
                </tr>
              </tbody>
            </table>

            {pnl.unclassified.length > 0 && (
              <div className="mt-4 border border-gray-200 border-l-2 border-l-amber-600 bg-white rounded-lg px-3 py-2 text-xs text-amber-800" data-testid="pnl-unclassified">
                <p className="font-semibold">Accounts with no type — not in revenue or cost</p>
                {pnl.unclassified.map((r) => (
                  <p key={r.key}>{r.label}: {fmt(r.amount)}</p>
                ))}
                <p className="mt-1 text-amber-700">Give them an account type (Adjustment journal → account) so they appear on a statement.</p>
              </div>
            )}

            <p className="mt-4 text-[11px] text-gray-500">
              Input VAT is an asset, output VAT a liability; retention withheld is a receivable.
            </p>
          </div>
        </TabsContent>

        {/* ---------------- Balance sheet ---------------- */}
        <TabsContent value="bs" className="pt-4">
          <div className="bg-white rounded-xl border p-5">
            <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
              <p className="text-xs text-gray-500">As at {period.to} · compared with {period.priorTo}</p>
              <span
                className={cn(
                  'text-xs rounded-full border px-2.5 py-1',
                  bs.balanced ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'
                )}
                data-testid="bs-check"
              >
                {bs.balanced ? 'Assets = liabilities + equity ✓' : `Out by ${fmt(bs.difference)}`}
              </span>
            </div>

            <table className="w-full text-sm" data-testid="bs-table">
              <TableHead periods={[period.to, period.priorTo]} />
              <tbody>
                <tr><td colSpan={4} className="pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Assets</td></tr>
                {bs.assets.length === 0 && <Line label="Nothing on the balance sheet yet" amount={0} prior={0} indent />}
                {bs.assets.map((section) => (
                  <FragmentSection key={section.key} section={section} />
                ))}
                <Line label="Total assets" amount={bs.totalAssets} prior={bs.totalAssetsPrior} bold testId="bs-assets" />

                <tr><td colSpan={4} className="pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Liabilities</td></tr>
                {bs.liabilities.length === 0 && <Line label="No liabilities" amount={0} prior={0} indent />}
                {bs.liabilities.map((section) => (
                  <FragmentSection key={section.key} section={section} />
                ))}
                <Line label="Total liabilities" amount={bs.totalLiabilities} prior={bs.totalLiabilitiesPrior} bold testId="bs-liabilities" />

                <tr><td colSpan={4} className="pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Equity</td></tr>
                {bs.equity.map((section) => (
                  <FragmentSection key={section.key} section={section} />
                ))}
                <Line label="Total equity" amount={bs.totalEquity} prior={bs.totalEquityPrior} bold testId="bs-equity" />

                <Line
                  label="Liabilities + equity"
                  amount={bs.totalLiabilitiesAndEquity}
                  prior={bs.totalLiabilitiesAndEquityPrior}
                  bold
                  testId="bs-liab-equity"
                />
                <Line label="Difference (assets − liabilities − equity)" amount={bs.difference} prior={bs.differencePrior} tone={Math.abs(bs.difference) < 0.005 ? 'positive' : 'negative'} />
              </tbody>
            </table>

            {bs.unclassified.length > 0 && (
              <div className="mt-4 border border-gray-200 border-l-2 border-l-amber-600 bg-white rounded-lg px-3 py-2 text-xs text-amber-800" data-testid="bs-unclassified">
                <p className="font-semibold">Accounts that could not be classified</p>
                {bs.unclassified.map((r) => <p key={r.account_id}>{r.name}: {fmt(r.amount)}</p>)}
              </div>
            )}

            <p className="mt-4 text-[11px] text-gray-500">
              Equity = capital + retained earnings brought forward + profit for this period, so the sheet ties to the P&amp;L without a manual closing entry. Worker balances are advances (asset) until wages are accrued, then a liability.
            </p>
          </div>
        </TabsContent>

        {/* ---------------- Project P&L ---------------- */}
        <TabsContent value="projects" className="pt-4">
          <div className="bg-white rounded-xl border p-5">
            <p className="text-xs text-gray-500 mb-3">
              Margin per job for {period.label}, next to its position to date (earned revenue from cost-to-cost completion, billed, over/under).
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="project-pnl-table">
                <thead className="text-[11px] uppercase tracking-wide text-gray-500 border-b border-gray-200">
                  <tr>
                    <th className="py-2 pr-4 text-left">Project</th>
                    <th className="py-2 px-3 text-right">Contract</th>
                    <th className="py-2 px-3 text-right">Revenue</th>
                    <th className="py-2 px-3 text-right">Cost</th>
                    <th className="py-2 px-3 text-right">Gross profit</th>
                    <th className="py-2 px-3 text-right">Margin</th>
                    <th className="py-2 px-3 text-right">% complete</th>
                    <th className="py-2 px-3 text-right">Billed to date</th>
                    <th className="py-2 pl-3 text-right">Over / (under)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {jobs.rows.length === 0 && (
                    <tr><td colSpan={9} className="py-8 text-center text-xs text-gray-400">No job activity in this period.</td></tr>
                  )}
                  {jobs.rows.map((r) => (
                    <tr key={r.project_id} data-testid={`project-row-${r.project_id}`}>
                      <td className="py-2 pr-4">
                        <p className="font-medium text-gray-900">{r.name}</p>
                        <p className="text-[11px] text-gray-400">
                          {r.project_id}
                          {r.costByKind.length > 0 && ` · ${r.costByKind.map((c) => `${c.label} ${fmt(c.amount)}`).join(' · ')}`}
                        </p>
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums text-gray-600">{fmt(r.contractValue)}</td>
                      <td className="py-2 px-3 text-right tabular-nums">{fmt(r.revenue)}</td>
                      <td className="py-2 px-3 text-right tabular-nums">{fmt(r.cost)}</td>
                      <td className={cn('py-2 px-3 text-right tabular-nums font-medium', r.grossProfit >= 0 ? 'text-emerald-700' : 'text-rose-700')}>
                        {fmt(r.grossProfit)}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums text-gray-600">{pct(r.margin)}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-gray-600">{r.pctComplete ? pct(r.pctComplete * 100) : '—'}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-gray-600">{fmt(r.billedToDate)}</td>
                      <td className={cn('py-2 pl-3 text-right tabular-nums', r.overUnder > 0 ? 'text-amber-700' : r.overUnder < 0 ? 'text-blue-700' : 'text-gray-400')}>
                        {r.overUnder === 0 ? '—' : fmt(Math.abs(r.overUnder))}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t-2 border-gray-200 font-semibold text-gray-900">
                  <tr>
                    <td className="py-2 pr-4">Total</td>
                    <td className="py-2 px-3"></td>
                    <td className="py-2 px-3 text-right tabular-nums">{fmt(jobs.totals.revenue)}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{fmt(jobs.totals.cost)}</td>
                    <td className={cn('py-2 px-3 text-right tabular-nums', jobs.totals.grossProfit >= 0 ? 'text-emerald-700' : 'text-rose-700')}>
                      {fmt(jobs.totals.grossProfit)}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">{pct(jobs.totals.margin)}</td>
                    <td className="py-2 px-3"></td>
                    <td className="py-2 px-3"></td>
                    <td className="py-2 pl-3"></td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="mt-3 text-[11px] text-gray-500">
              Over-billed (positive) means billed more than earned — a liability in substance; under-billed (blue) means cost and earnings ahead of billing.               Both are read from cost-to-cost completion to {period.to}.
            </p>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function FragmentSection({ section }: { section: { label: string; rows: { account_id: string; name: string; amount: number; prior: number }[]; total: number; totalPrior: number } }) {
  return (
    <>
      <tr><td colSpan={4} className="pt-2 pb-0.5 text-[11px] font-medium text-gray-500">{section.label}</td></tr>
      {section.rows.map((r) => (
        <Line key={r.account_id} label={r.name} amount={r.amount} prior={r.prior} indent />
      ))}
      <Line label={`Subtotal · ${section.label}`} amount={section.total} prior={section.totalPrior} />
    </>
  );
}
