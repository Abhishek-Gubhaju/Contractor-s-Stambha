// Job Cost view (S4.4) — two roll-ups over the same line table:
//   1. per PROJECT: accrued expense vs paid cash vs budget (contract value)
//   2. per PROJECT × COST CODE: where the money actually went, against the
//      budgets declared by BOQ items tagged with a cost code.
// Read-only. Budgets for cost codes come from the BOQ document, so tagging BOQ
// items is what turns a contract value into a cost baseline.
import { useEffect, useState } from 'react';
import { formatCurrency, cn } from '../../utils';
import { jobCostByCode, type JobCostCodeRow, type JobCostProjectRow } from '../../services/booksService';
import { loadProjects } from '../../services/masterData';
import { getActiveProject } from '../../services/projectScope';

function burnBar(spent: number, budget: number) {
  const pct = budget > 0 ? Math.min(100, Math.round((spent / budget) * 100)) : 0;
  return (
    <div className="w-32 h-2 bg-gray-100 rounded-full overflow-hidden" aria-hidden>
      <div
        className={cn('h-full', budget > 0 && spent > budget ? 'bg-rose-500' : 'bg-blue-500')}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

const KIND_LABEL: Record<JobCostCodeRow['kind'], string> = {
  material: 'Material',
  labour: 'Labour',
  subcontract: 'Subcontract',
  equipment: 'Equipment',
  other: 'Other',
};

export default function JobCostView({ version }: { version: number }) {
  void version;
  // The workspace is scoped to one job, so the view opens on it.
  const [filter, setFilter] = useState(getActiveProject());

  // Commitments are recorded on another page; refresh this view when they move.
  const [, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    window.addEventListener('contractoros:commitments-changed', bump);
    return () => window.removeEventListener('contractoros:commitments-changed', bump);
  }, []);

  const all = jobCostByCode();
  const view = filter === 'all' ? all : jobCostByCode(filter);
  const projects: JobCostProjectRow[] = view.projects;
  const codes: JobCostCodeRow[] = view.codes;

  if (all.projects.length === 0 && all.codes.length === 0) {
    return (
      <div className="text-center py-16 text-gray-400 text-sm" data-testid="jobcost-empty">
        No project costs yet — entries with a project tag appear here.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-gray-500">
          Accrued = expense debits · committed = open POs/subcontracts · forecast = accrued + committed ·
          paid = cash/bank lines · cost-code budgets come from BOQ items that carry a cost code.
        </p>
        <label className="flex items-center gap-2 text-xs text-gray-600">
          Project
          <select
            className="border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs bg-white"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            data-testid="jobcost-project-filter"
          >
            <option value="all">All projects</option>
            {loadProjects().map((p) => (
              <option key={p.id} value={p.id}>{p.id} · {p.name}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="border border-gray-200 rounded-xl overflow-hidden bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-500">
            <tr>
              <th className="text-left px-4 py-2">Project</th>
              <th className="text-right px-4 py-2">Accrued</th>
              <th className="text-right px-4 py-2">Committed</th>
              <th className="text-right px-4 py-2">Forecast</th>
              <th className="text-right px-4 py-2">Paid</th>
              <th className="text-right px-4 py-2">Budget</th>
              <th className="text-right px-4 py-2">Forecast variance</th>
              <th className="px-4 py-2">Burn</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {projects.map((r) => (
              <tr key={r.project_id} data-testid={`jobcost-${r.project_id}`}>
                <td className="px-4 py-2.5 font-medium text-gray-900">
                  <span className="block">{r.name}</span>
                  <span className="block text-xs text-gray-400">{r.project_id}</span>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums" data-testid={`jobcost-accrued-${r.project_id}`}>{formatCurrency(r.accrued)}</td>
                <td className={cn('px-4 py-2.5 text-right tabular-nums', r.committed > 0 ? 'text-indigo-700 font-medium' : 'text-gray-400')} data-testid={`jobcost-committed-${r.project_id}`}>
                  {formatCurrency(r.committed)}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums font-medium" data-testid={`jobcost-forecast-${r.project_id}`}>{formatCurrency(r.forecast)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums" data-testid={`jobcost-paid-${r.project_id}`}>{formatCurrency(r.paid)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-gray-600">{r.budget ? formatCurrency(r.budget) : '—'}</td>
                <td className={cn('px-4 py-2.5 text-right tabular-nums font-medium', r.budget === 0 ? 'text-gray-400' : r.budget - r.forecast >= 0 ? 'text-emerald-700' : 'text-rose-700')} data-testid={`jobcost-variance-${r.project_id}`}>
                  {r.budget ? formatCurrency(r.budget - r.forecast) : '—'}
                </td>
                <td className="px-4 py-2.5">{burnBar(r.forecast, r.budget)}</td>
              </tr>
            ))}
            {projects.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-400 text-sm">No costs on this project yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="border border-gray-200 rounded-xl overflow-hidden bg-white">
        <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200">
          <p className="text-xs font-semibold uppercase text-gray-500">By cost code</p>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-500">
            <tr>
              <th className="text-left px-4 py-2">Project</th>
              <th className="text-left px-4 py-2">Code</th>
              <th className="text-left px-4 py-2">Cost code</th>
              <th className="text-left px-4 py-2">Kind</th>
              <th className="text-right px-4 py-2">Accrued</th>
              <th className="text-right px-4 py-2">Committed</th>
              <th className="text-right px-4 py-2">Forecast</th>
              <th className="text-right px-4 py-2">Budget</th>
              <th className="text-right px-4 py-2">Forecast variance</th>
              <th className="px-4 py-2">Burn</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {codes.map((r) => (
              <tr key={`${r.project_id}|${r.code}`} data-testid={`jobcost-code-${r.project_id}-${r.code}`}>
                <td className="px-4 py-2 text-gray-500 text-xs font-mono">{r.project_id}</td>
                <td className="px-4 py-2 font-mono text-xs">{r.code}</td>
                <td className="px-4 py-2 text-gray-900">{r.name}</td>
                <td className="px-4 py-2 text-xs text-gray-500">{KIND_LABEL[r.kind]}</td>
                <td className="px-4 py-2 text-right tabular-nums" data-testid={`jobcost-code-accrued-${r.project_id}-${r.code}`}>{formatCurrency(r.accrued)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-indigo-700" data-testid={`jobcost-code-committed-${r.project_id}-${r.code}`}>{r.committed ? formatCurrency(r.committed) : '—'}</td>
                <td className="px-4 py-2 text-right tabular-nums font-medium" data-testid={`jobcost-code-forecast-${r.project_id}-${r.code}`}>{formatCurrency(r.forecast)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-gray-600" data-testid={`jobcost-code-budget-${r.project_id}-${r.code}`}>{r.budget ? formatCurrency(r.budget) : '—'}</td>
                <td className={cn('px-4 py-2 text-right tabular-nums font-medium', r.budget === 0 ? 'text-gray-400' : r.forecastVariance >= 0 ? 'text-emerald-700' : 'text-rose-700')}>
                  {r.budget === 0 ? '—' : formatCurrency(r.forecastVariance)}
                </td>
                <td className="px-4 py-2">{burnBar(r.forecast, r.budget)}</td>
              </tr>
            ))}
            {codes.length === 0 && (
              <tr><td colSpan={10} className="px-4 py-8 text-center text-gray-400 text-sm">No cost-code activity in this period.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
