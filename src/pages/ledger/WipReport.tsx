// WIP (Work In Progress) schedule — percentage of completion by cost.
//
//   % complete    = cost to date ÷ estimated cost at completion
//   earned revenue = % complete × contract value
//   over/(under)  = billings to date − earned revenue
//
// Over-billed (> 0) is a liability: the client has been billed ahead of the
// work. Under-billed (< 0) is an asset: work done and not yet billed. Monthly
// WIP is the report that ties job cost, revenue and billing together.
import { formatCurrency, cn } from '../../utils';
import { wipReport } from '../../services/booksService';
import { useActiveProject } from '../../services/projectScope';

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export default function WipReport({ to }: { to?: string }) {
  const activeProject = useActiveProject();
  const report = wipReport(to);
  // The workspace is scoped to one job, so the schedule shows only that job.
  const rows = report.rows.filter((r) => r.project_id === activeProject);
  const asOf = report.asOf;
  const sum = (pick: (r: (typeof rows)[number]) => number) =>
    Math.round(rows.reduce((s, r) => s + pick(r), 0) * 100) / 100;
  const totals = {
    contract: sum((r) => r.contract),
    costToDate: sum((r) => r.costToDate),
    estimatedCost: sum((r) => r.estimatedCost),
    earnedRevenue: sum((r) => r.earnedRevenue),
    billings: sum((r) => r.billings),
    retention: sum((r) => r.retention),
    overUnder: sum((r) => r.overUnder),
    grossProfit: sum((r) => r.grossProfit),
    pctComplete: 0,
  };
  totals.pctComplete = totals.estimatedCost > 0 ? totals.costToDate / totals.estimatedCost : 0;

  if (rows.length === 0) {
    return (
      <div className="text-center py-16 text-gray-400 text-sm" data-testid="wip-empty">
        No job cost or billing activity yet — WIP appears once a project has costs or invoices.
      </div>
    );
  }

  const incomplete = rows.filter((r) => !r.complete).length;

  return (
    <div className="space-y-3" data-testid="wip-report">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-gray-500">
          Cumulative to <b className="text-gray-700">{asOf}</b> · % complete = cost to date ÷ estimated cost at completion ·
          {' '}<span className={cn('font-medium', totals.overUnder > 0 ? 'text-amber-700' : totals.overUnder < 0 ? 'text-blue-700' : 'text-gray-500')}>
            net {totals.overUnder > 0 ? 'over' : totals.overUnder < 0 ? 'under' : ''}-billed {formatCurrency(Math.abs(totals.overUnder))}
          </span>
        </p>
        <div className="flex items-center gap-2 text-xs">
          <span className="border border-gray-200 border-l-2 border-l-amber-600 bg-white text-amber-800 rounded-full px-2.5 py-1">
            Over-billed = liability
          </span>
          <span className="border border-blue-200 bg-blue-50 text-blue-700 rounded-full px-2.5 py-1">
            Under-billed = asset
          </span>
        </div>
      </div>

      {incomplete > 0 && (
        <p className="text-xs text-amber-800 bg-white border border-gray-200 border-l-2 border-l-amber-600 rounded-lg px-3 py-2" data-testid="wip-warning">
          {incomplete} project{incomplete > 1 ? 's have' : ' has'} no estimated cost at completion — % complete and earned
          revenue cannot be calculated. Set it in Settings → Projects.
        </p>
      )}

      <div className="border border-gray-200 rounded-xl overflow-hidden bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-500">
            <tr>
              <th className="text-left px-4 py-2">Project</th>
              <th className="text-right px-3 py-2">Contract</th>
              <th className="text-right px-3 py-2">Cost to date</th>
              <th className="text-right px-3 py-2">Est. cost at completion</th>
              <th className="text-right px-3 py-2">% complete</th>
              <th className="text-right px-3 py-2">Revenue earned</th>
              <th className="text-right px-3 py-2">Billings</th>
              <th className="text-right px-3 py-2">Retention</th>
              <th className="text-right px-3 py-2">Over/(under)</th>
              <th className="text-right px-4 py-2">Gross profit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((r) => (
              <tr key={r.project_id} data-testid={`wip-row-${r.project_id}`}>
                <td className="px-4 py-2.5">
                  <span className="block font-medium text-gray-900">{r.name}</span>
                  <span className="block text-xs text-gray-400 font-mono">{r.project_id}</span>
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">{r.contract ? formatCurrency(r.contract) : '—'}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{formatCurrency(r.costToDate)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {r.complete ? formatCurrency(r.estimatedCost) : <span className="text-amber-700">not set</span>}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums font-medium" data-testid={`wip-pct-${r.project_id}`}>
                  {r.complete ? pct(r.pctComplete) : '—'}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums" data-testid={`wip-earned-${r.project_id}`}>
                  {formatCurrency(r.earnedRevenue)}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">{formatCurrency(r.billings)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-gray-600">{r.retention ? formatCurrency(r.retention) : '—'}</td>
                <td
                  className={cn('px-3 py-2.5 text-right tabular-nums font-medium', r.overUnder > 0 ? 'text-amber-700' : r.overUnder < 0 ? 'text-blue-700' : 'text-gray-400')}
                  data-testid={`wip-overunder-${r.project_id}`}
                >
                  {formatCurrency(r.overUnder)}
                  <span className="block text-[11px] font-normal">
                    {r.overUnder > 0 ? 'over-billed' : r.overUnder < 0 ? 'under-billed' : '—'}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums font-medium">{formatCurrency(r.grossProfit)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-slate-800 text-white">
            <tr>
              <td className="px-4 py-2.5 font-semibold">Totals</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{formatCurrency(totals.contract)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{formatCurrency(totals.costToDate)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{formatCurrency(totals.estimatedCost)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{totals.estimatedCost ? pct(totals.pctComplete) : '—'}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{formatCurrency(totals.earnedRevenue)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{formatCurrency(totals.billings)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{formatCurrency(totals.retention)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums" data-testid="wip-total-overunder">{formatCurrency(totals.overUnder)}</td>
              <td className="px-4 py-2.5 text-right tabular-nums">{formatCurrency(totals.grossProfit)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
