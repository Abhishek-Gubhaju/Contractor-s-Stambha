// Commitments register — open purchase orders and subcontracts.
//
// A commitment is money promised on a job before the invoice arrives. Job Cost
// forecasts actual + open commitments, so this page is where the promise is
// recorded and released (approved/ordered → received/cancelled).
import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { formatCurrency, todayISOInKathmandu } from '../utils';
import { loadCostCodes, loadProjects, projectNameOf } from '../services/masterData';
import { getActiveProject } from '../services/projectScope';
import { destroyDialog } from '../components/ui/DialogHost';
import {
  COMMITMENT_STATUSES,
  commitmentTotals,
  isOpenCommitment,
  loadCommitments,
  removeCommitment,
  setCommitmentStatus,
  upsertCommitment,
  type Commitment,
  type CommitmentKind,
  type CommitmentStatus,
} from '../services/commitments';

const STATUS_STYLE: Record<CommitmentStatus, string> = {
  draft: 'bg-gray-100 text-gray-600',
  approved: 'bg-gray-100 text-gray-700',
  ordered: 'bg-gray-100 text-gray-700',
  received: 'bg-green-50 text-green-700',
  cancelled: 'bg-red-50 text-red-700',
};

const emptyForm = {
  kind: 'po' as CommitmentKind,
  ref: '',
  vendor: '',
  project_id: '',
  cost_code: '',
  amount: '',
  status: 'approved' as CommitmentStatus,
  date: todayISOInKathmandu(),
};

export default function CommitmentsPage() {
  const [rows, setRows] = useState<Commitment[]>(() => loadCommitments());
  const [form, setForm] = useState({ ...emptyForm, project_id: getActiveProject() });
  const [error, setError] = useState('');
  // Commitments belong to a job, so the register opens on the active one.
  const [filter, setFilter] = useState(getActiveProject());

  const projects = loadProjects();
  const costCodes = loadCostCodes();
  const refresh = () => setRows(loadCommitments());

  const add = () => {
    try {
      upsertCommitment({
        kind: form.kind,
        ref: form.ref,
        vendor: form.vendor,
        project_id: form.project_id,
        cost_code: form.cost_code,
        amount: Number(form.amount),
        status: form.status,
        date: form.date,
      });
      setForm({ ...emptyForm, kind: form.kind, project_id: getActiveProject() });
      setError('');
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const changeStatus = (id: string, status: CommitmentStatus) => {
    setCommitmentStatus(id, status);
    refresh();
  };

  const remove = async (id: string) => {
    const ok = await destroyDialog({
      title: 'Delete commitment',
      message: 'Delete this commitment? Posted costs are unaffected.',
    });
    if (!ok) return;
    removeCommitment(id);
    refresh();
  };

  const visible = filter === 'all' ? rows : rows.filter((r) => (filter === 'unallocated' ? !r.project_id : r.project_id === filter));
  const openVisible = visible.filter(isOpenCommitment);
  const sumBy = (list: typeof openVisible) => Math.round(list.reduce((s, r) => s + r.amount, 0) * 100) / 100;
  const totals = {
    count: openVisible.length,
    total: sumBy(openVisible),
    allocated: sumBy(openVisible.filter((r) => r.project_id)),
    unallocated: sumBy(openVisible.filter((r) => !r.project_id)),
  };

  return (
    <div className="space-y-4">
      <div>
        <h1>Commitments</h1>
        <p className="text-xs text-gray-400 font-mono">{getActiveProject()} · {projectNameOf(getActiveProject())}</p>
        <p className="text-sm text-gray-500">
          Purchase orders and subcontracts promised on a job before invoicing.
          Job Cost reports actual + open commitments as the forecast.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border p-4">
          <p className="text-xs text-gray-500">Open commitments</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{formatCurrency(totals.total)}</p>
          <p className="text-xs text-gray-400">{totals.count} open · approved or ordered</p>
        </div>
        <div className="bg-white rounded-xl border p-4">
          <p className="text-xs text-gray-500">Allocated to a job</p>
          <p className="text-2xl font-bold text-blue-700 mt-1">{formatCurrency(totals.allocated)}</p>
          <p className="text-xs text-gray-400">included in job forecasts</p>
        </div>
        <div className="bg-white rounded-xl border p-4">
          <p className="text-xs text-gray-500">Unallocated</p>
          <p className={`text-2xl font-bold mt-1 ${totals.unallocated > 0 ? 'text-amber-700' : 'text-gray-400'}`}>{formatCurrency(totals.unallocated)}</p>
          <p className="text-xs text-gray-400">assign a job to forecast it</p>
        </div>
      </div>

      <div className="bg-white rounded-xl border p-4 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-600">Record a commitment</p>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <label className="text-xs text-gray-600">
            Type
            <select
              className="mt-1 w-full border border-gray-300 rounded-lg px-2.5 py-2 text-sm bg-white"
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value as CommitmentKind })}
              aria-label="Commitment type"
            >
              <option value="po">Purchase order</option>
              <option value="subcontract">Subcontract</option>
            </select>
          </label>
          <label className="text-xs text-gray-600">
            Reference
            <input
              className="mt-1 w-full border border-gray-300 rounded-lg px-2.5 py-2 text-sm font-mono"
              placeholder="PO-2026-001"
              value={form.ref}
              onChange={(e) => setForm({ ...form, ref: e.target.value })}
              aria-label="Commitment reference"
            />
          </label>
          <label className="text-xs text-gray-600">
            Vendor
            <input
              className="mt-1 w-full border border-gray-300 rounded-lg px-2.5 py-2 text-sm"
              placeholder="Supplier name"
              value={form.vendor}
              onChange={(e) => setForm({ ...form, vendor: e.target.value })}
              aria-label="Commitment vendor"
            />
          </label>
          <label className="text-xs text-gray-600">
            Amount
            <input
              type="number"
              min={0}
              step="any"
              className="mt-1 w-full border border-gray-300 rounded-lg px-2.5 py-2 text-sm"
              placeholder="0"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              aria-label="Commitment amount"
            />
          </label>
          <label className="text-xs text-gray-600">
            Project / job
            <input
              list="commitment-projects"
              className="mt-1 w-full border border-gray-300 rounded-lg px-2.5 py-2 text-sm"
              placeholder="PRJ-001"
              value={form.project_id}
              onChange={(e) => setForm({ ...form, project_id: e.target.value })}
              aria-label="Commitment project"
            />
            <datalist id="commitment-projects">
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </datalist>
          </label>
          <label className="text-xs text-gray-600">
            Cost code
            <select
              className="mt-1 w-full border border-gray-300 rounded-lg px-2.5 py-2 text-sm bg-white"
              value={form.cost_code}
              onChange={(e) => setForm({ ...form, cost_code: e.target.value })}
              aria-label="Commitment cost code"
            >
              <option value="">Unassigned</option>
              {costCodes.map((c) => <option key={c.code} value={c.name}>{c.code} · {c.name}</option>)}
            </select>
          </label>
          <label className="text-xs text-gray-600">
            Status
            <select
              className="mt-1 w-full border border-gray-300 rounded-lg px-2.5 py-2 text-sm bg-white"
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value as CommitmentStatus })}
              aria-label="Commitment status"
            >
              {COMMITMENT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="text-xs text-gray-600">
            Date
            <input
              type="date"
              className="mt-1 w-full border border-gray-300 rounded-lg px-2.5 py-2 text-sm"
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
              aria-label="Commitment date"
            />
          </label>
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] text-gray-400">
            Only <b>approved</b> and <b>ordered</b> commitments count in forecasts. Received or cancelled release the commitment.
          </p>
          <button
            onClick={add}
            className="inline-flex items-center gap-1.5 bg-gray-900 hover:bg-gray-800 text-white px-4 py-2 rounded-lg text-sm font-medium"
          >
            <Plus className="w-4 h-4" /> Add commitment
          </button>
        </div>
        {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-gray-700">Register</p>
        <label className="text-xs text-gray-600 flex items-center gap-2">
          Filter
          <select
            className="border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs bg-white"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            data-testid="commitment-filter"
          >
            <option value="all">All</option>
            <option value="unallocated">Unallocated</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.id} · {p.name}</option>)}
          </select>
        </label>
      </div>

      <div className="bg-white rounded-xl border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-500">
            <tr>
              <th className="text-left px-4 py-2">Reference</th>
              <th className="text-left px-4 py-2">Type</th>
              <th className="text-left px-4 py-2">Vendor</th>
              <th className="text-left px-4 py-2">Project</th>
              <th className="text-left px-4 py-2">Cost code</th>
              <th className="text-right px-4 py-2">Amount</th>
              <th className="text-left px-4 py-2">Status</th>
              <th className="text-right px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {visible.map((c) => (
              <tr key={c.id} data-testid={`commitment-${c.id}`}>
                <td className="px-4 py-2.5 font-mono text-xs text-gray-700">{c.ref || '—'}</td>
                <td className="px-4 py-2.5 capitalize text-gray-600">{c.kind === 'po' ? 'PO' : 'Subcontract'}</td>
                <td className="px-4 py-2.5 text-gray-800">{c.vendor || '—'}</td>
                <td className="px-4 py-2.5 text-xs font-mono text-gray-500">{c.project_id || <span className="text-amber-700">unallocated</span>}</td>
                <td className="px-4 py-2.5 text-xs text-gray-600">{c.cost_code || '—'}</td>
                <td className="px-4 py-2.5 text-right tabular-nums font-medium">{formatCurrency(c.amount)}</td>
                <td className="px-4 py-2.5">
                  <select
                    value={c.status}
                    onChange={(e) => changeStatus(c.id, e.target.value as CommitmentStatus)}
                    className={`text-xs font-medium rounded-full px-2 py-0.5 border-0 ${STATUS_STYLE[c.status]}`}
                    aria-label={`Status for ${c.ref}`}
                  >
                    {COMMITMENT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <button onClick={() => remove(c.id)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded" aria-label={`Delete ${c.ref}`}>
                    <Trash2 className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-12 text-center text-gray-400" data-testid="commitment-empty">
                No commitments recorded yet.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
