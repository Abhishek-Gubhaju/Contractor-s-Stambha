// ============================================================================
// DSR page — the daily site report register + editor + printable sheet.
//
// A contractor's day produces a report with several work items, the trades on
// site, plant, material movement, tests, lost time and safety. This page keeps
// that register — one entry per report, each numbered, and more than one per
// date when the job records separate fronts or shifts — and drives the
// draft → submitted → approved workflow. Quantities are the same quantities
// Work Progress, Gantt, Job Costing and the Dashboard read (dsrService.dsrLines),
// so nothing downstream can drift from what the site recorded.
// ============================================================================
import { useMemo, useRef, useState } from 'react';
import {
  Plus, Trash2, Edit3, X, CheckCircle, Clock, AlertTriangle, ExternalLink,
  Printer, Search, ShieldCheck, Undo2, Download, Paperclip,
} from 'lucide-react';
import { Modal } from '../components/ui';
import { formatBS, getTodayBS } from '../utils/nepaliDate';
import { getCurrentDateInTimezone } from '../utils';
import { projectNameOf } from '../services/masterData';
import { getActiveProject, useScopedLocalStorage } from '../services/projectScope';
import { destroyDialog, notify } from '../components/ui/DialogHost';
import {
  blankReport,
  migrateReports,
  sortReports,
  validateReport,
  nextReportNo,
  withMirrors,
  submitReport,
  approveReport,
  reopenReport,
  canEdit,
  round2,
  labourCount,
  labourHours,
  delayHours,
  dsrLines,
  WEATHER_LABEL,
  type DsrAttachment,
  type DsrReport,
  type BoqRef,
} from '../services/dsrService';
import {
  focusInVault,
  mergeDsrAttachments,
  retargetDsrAttachments,
  withoutDsrAttachment,
} from '../services/dsrAttachments';
import { activeUser } from '../services/auth/authService';
import { DsrEditor } from './dsr/DsrEditor';
import { DsrSheet } from './dsr/DsrSheet';
import { usePrintTarget } from '../hooks/usePrintTarget';
import { printSheet } from '../services/print/printService';

const bsDate = (report: DsrReport) => formatBS({ year: report.bs_y, month: report.bs_m, day: report.bs_d });

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700 border-gray-200',
  submitted: 'bg-amber-50 text-amber-700 border-amber-200',
  approved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
};

export default function DSRPage(props: any) {
  const { dsrData = [], setDsrData, boqData = [], laborData = [], timezone = 'Asia/Kathmandu', onNavigate } = props;
  const projectId = getActiveProject();
  const today = getCurrentDateInTimezone(timezone);
  const todayBs = getTodayBS();

  const reports = useMemo(() => sortReports(migrateReports(dsrData, projectId)), [dsrData, projectId]);

  const [month, setMonth] = useState(`${today.slice(0, 7)}`);
  const [statusFilter, setStatusFilter] = useState<'all' | 'draft' | 'submitted' | 'approved'>('all');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<DsrReport | null>(null);
  const [printing, setPrinting] = useState<DsrReport | null>(null);
  const [reopenReason, setReopenReason] = useState('');
  const [saving, setSaving] = useState(false);
  // A ref, not the state value: two clicks in the same tick both see the
  // pre-render `false`, and the second save would move files twice.
  const savingRef = useRef(false);
  const [deleted, setDeleted] = useScopedLocalStorage<DsrReport[]>('contractoros_dsr_deleted', []);
  const [showDeleted, setShowDeleted] = useState(false);
  // The sheet that Cmd+P / the print button sends to paper: the open report.
  const printRef = usePrintTarget<HTMLDivElement>({
    title: printing ? `DSR ${printing.reportNo || printing.date}` : 'Daily Site Report',
  });

  const boq: BoqRef[] = useMemo(
    () =>
      (boqData || []).flatMap((section: any) =>
        (section.children || []).map((item: any) => ({
          itemCode: String(item.itemCode || ''),
          description: String(item.description || ''),
          unit: String(item.unit || ''),
          quantity: Number(item.estimatedQuantity) || 0,
          rate: Number(item.rate) || 0,
        }))
      ),
    [boqData]
  );

  const persist = (next: DsrReport[]) => {
    setDsrData?.(sortReports(next));
  };

  const monthReports = reports.filter((r) => String(r.date).slice(0, 7) === month);
  const visible = monthReports.filter((r) => {
    if (statusFilter !== 'all' && r.status !== statusFilter) return false;
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      String(r.reportNo).toLowerCase().includes(q) ||
      r.items.some((i) => String(i.boqCode).toLowerCase().includes(q) || String(i.description).toLowerCase().includes(q) || String(i.location).toLowerCase().includes(q)) ||
      (r.attachments || []).some((row) => String(row.name).toLowerCase().includes(q))
    );
  });

  const stats = (() => {
    const lines = dsrLines(monthReports);
    const approved = monthReports.filter((r) => r.status === 'approved').length;
    const submitted = monthReports.filter((r) => r.status === 'submitted').length;
    const labour = monthReports.reduce((s, r) => s + labourHours(r), 0);
    const lost = monthReports.reduce((s, r) => s + delayHours(r), 0);
    return { count: monthReports.length, approved, submitted, draft: monthReports.length - approved - submitted, lines: lines.length, labour, lost };
  })();

  const check = (report: DsrReport, submit: boolean) =>
    validateReport(report, { existing: reports, boq, submit, today, projectId });

  // Live validation — strict enough for the state the report is in, and silent
  // for a locked (approved) report that is only being read.
  const validation = !editing || !canEdit(editing)
    ? { errors: [], warnings: [] }
    : check(editing, editing.status !== 'draft');

  const openReport = (report: DsrReport) => {
    setEditing(report);
    setReopenReason('');
  };

  // Always a NEW numbered document: an existing (possibly approved and locked)
  // report for today must never stand in for a fresh entry.
  const openNew = () => openReport(blankReport(projectId, today));

  const attachDocs = (rows: DsrAttachment[]) => {
    // Functional update: an upload may resolve after the supervisor typed, and
    // a captured report object would overwrite those keystrokes.
    setEditing((prev) =>
      prev ? { ...prev, attachments: mergeDsrAttachments(prev.attachments, rows) } : prev
    );
  };

  const detachDoc = (id: string) => {
    setEditing((prev) => (prev ? withoutDsrAttachment(prev, id) : prev));
  };

  const openInVault = (docId: string) => {
    focusInVault({ projectId, docId });
    onNavigate?.('vault');
  };

  const save = async (status: 'draft' | 'submitted' | 'approved') => {
    if (!editing || savingRef.current) return;
    const result = check(editing, status !== 'draft');
    if (result.errors.length > 0) {
      notify(result.errors[0], 'error');
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      let report: DsrReport = {
        ...editing,
        reportNo: editing.reportNo || nextReportNo(editing.date, reports.filter((r) => r.id !== editing.id)),
      };
      if (status === 'submitted' && report.status === 'draft') report = submitReport(report, 'Submitted to the engineer');
      if (status === 'approved' && report.status === 'submitted') report = approveReport(report, 'Checked and approved on site');
      report = withMirrors(report);

      // The file folder is the report's date. If the date moved after the files
      // were attached, move them with it — best effort, never a save blocker.
      const stored = reports.find((r) => r.id === report.id);
      const dateChanged = !stored || stored.date !== report.date;
      if (dateChanged && (report.attachments?.length ?? 0) > 0) {
        try {
          const moved = await retargetDsrAttachments(report, {
            userId: activeUser()?.id ?? '',
            projectId,
          });
          if (moved.warnings.length > 0) notify(moved.warnings[0], 'error');
        } catch (error) {
          notify(
            error instanceof Error ? error.message : 'The linked files could not be moved; they stay in the Vault.',
            'error'
          );
        }
      }

      const exists = reports.some((r) => r.id === report.id);
      persist(exists ? reports.map((r) => (r.id === report.id ? report : r)) : [...reports, report]);
      setEditing(report);
      notify(`${report.reportNo} saved as ${report.status}.`, 'info');
      if (status !== 'draft') setEditing(null);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const removeReport = async (report: DsrReport) => {
    const ok = await destroyDialog({
      title: 'Delete daily report',
      message: `${report.reportNo || report.date} — its quantities stop counting towards progress. It can be restored from Recently deleted. Its files stay in the File Vault.`,
      confirmLabel: 'Delete report',
    });
    if (!ok) return;
    persist(reports.filter((r) => r.id !== report.id));
    setDeleted([...(deleted || []), report]);
  };

  const restore = (report: DsrReport) => {
    persist([...reports, report]);
    setDeleted((deleted || []).filter((r) => r.id !== report.id));
  };

  const purgeReport = async (report: DsrReport) => {
    const ok = await destroyDialog({
      title: 'Delete permanently',
      message: `Permanently delete ${report.reportNo || report.date}? It cannot be restored after this.`,
      confirmLabel: 'Delete permanently',
    });
    if (!ok) return;
    setDeleted((deleted || []).filter((r) => r.id !== report.id));
  };

  const exportCsv = () => {
    const header = ['Date (A.D.)', 'Report no.', 'Status', 'Weather', 'Shift', 'Work items', 'Total qty', 'Labour', 'Labour hours', 'Lost hours', 'Prepared by', 'Checked by'];
    const rows = visible.map((r) => [
      r.date,
      r.reportNo,
      r.status,
      WEATHER_LABEL[r.weather] || r.weather,
      r.shift,
      r.items.map((i) => `${i.boqCode}${i.location ? ` @ ${i.location}` : ''}: ${i.quantity} ${i.unit}`).join(' | '),
      round2(r.items.reduce((s, i) => s + (Number(i.quantity) || 0), 0)),
      labourCount(r),
      labourHours(r),
      delayHours(r),
      r.preparedBy,
      r.checkedBy,
    ]);
    const escape = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [header, ...rows].map((row) => row.map(escape).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `DSR-${projectId}-${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const doReopen = () => {
    if (!editing) return;
    try {
      const reopened = withMirrors(reopenReport(editing, reopenReason));
      persist(reports.map((r) => (r.id === reopened.id ? reopened : r)));
      setEditing(reopened);
      setReopenReason('');
      notify(`${reopened.reportNo} reopened for correction.`, 'info');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1>Daily Site Reports</h1>
          <p className="text-sm text-gray-500">
            {projectId}: {projectNameOf(projectId)}
          </p>
          <p className="text-xs text-indigo-600 font-medium">B.S. Today: {formatBS(todayBs)}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={exportCsv} className="inline-flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-800 px-3 py-2 rounded-lg border border-gray-200 bg-white" data-testid="dsr-export">
            <Download className="w-4 h-4" /> CSV
          </button>
          {(deleted || []).length > 0 && (
            <button onClick={() => setShowDeleted(true)} className="inline-flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-800 px-3 py-2 rounded-lg border border-gray-200 bg-white">
              <Trash2 className="w-4 h-4" /> Deleted ({deleted.length})
            </button>
          )}
          <button
            onClick={openNew}
            data-testid="dsr-new"
            className="flex items-center gap-1.5 bg-gray-900 hover:bg-gray-800 text-white px-4 py-2 rounded-lg text-sm font-medium"
          >
            <Plus className="w-4 h-4" /> New DSR
          </button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { label: 'Reports', value: stats.count, hint: `${stats.approved} approved · ${stats.submitted} submitted` },
          { label: 'Work lines', value: stats.lines, hint: 'BOQ items reported' },
          { label: 'Labour hours', value: Math.round(stats.labour), hint: 'men × hours' },
          { label: 'Lost hours', value: stats.lost, hint: 'rain / breakdown / delay' },
          { label: 'Drafts', value: stats.draft, hint: 'not yet submitted' },
        ].map((k) => (
          <div key={k.label} className="bg-white rounded-xl border p-3">
            <p className="text-[11px] uppercase tracking-wide text-gray-500">{k.label}</p>
            <p className="text-xl font-bold text-gray-900 tabular-nums">{k.value}</p>
            <p className="text-[10px] text-gray-400">{k.hint}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm"
          aria-label="Report month"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as any)}
          className="border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm"
          aria-label="Status filter"
        >
          <option value="all">All status</option>
          <option value="draft">Draft</option>
          <option value="submitted">Submitted</option>
          <option value="approved">Approved</option>
        </select>
        <div className="relative">
          <Search className="w-4 h-4 text-gray-400 absolute left-2 top-2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search BOQ code, location, report no."
            className="border border-gray-200 rounded-lg pl-8 pr-3 py-1.5 text-sm w-72"
            aria-label="Search reports"
          />
        </div>
        <span className="text-xs text-gray-500">{visible.length} report(s)</span>
      </div>

      {/* Register */}
      <div className="bg-white rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-[11px] uppercase text-gray-500">
            <tr>
              <th className="text-left px-3 py-2">Date</th>
              <th className="text-left px-3 py-2">Report</th>
              <th className="text-left px-3 py-2">Work reported</th>
              <th className="text-right px-3 py-2">Labour</th>
              <th className="text-right px-3 py-2">Lost</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-right px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {visible.map((r) => (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="px-3 py-2 whitespace-nowrap">
                  <p className="font-medium">{bsDate(r)}</p>
                  <p className="text-[11px] text-gray-400">{r.date} · {WEATHER_LABEL[r.weather] || r.weather}</p>
                </td>
                <td className="px-3 py-2 font-mono text-xs">{r.reportNo || '—'}</td>
                <td className="px-3 py-2">
                  <p className="text-xs text-gray-700 truncate max-w-[320px]">
                    {r.items.map((i) => i.boqCode || i.description).filter(Boolean).slice(0, 3).join(' · ') || 'No work item'}
                  </p>
                  <p className="text-[11px] text-gray-400 flex items-center gap-1.5">
                    <span>
                      {r.items.length} item(s) · {round2(r.items.reduce((s, i) => s + (Number(i.quantity) || 0), 0))} total qty
                    </span>
                    {(r.attachments?.length ?? 0) > 0 && (
                      <span
                        className="inline-flex items-center gap-0.5 text-gray-500"
                        data-testid={`dsr-file-count-${r.id}`}
                        aria-label={`${r.attachments.length} files attached`}
                      >
                        <Paperclip className="w-3 h-3" aria-hidden="true" /> {r.attachments.length}
                      </span>
                    )}
                  </p>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{labourCount(r)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{delayHours(r) || '—'}</td>
                <td className="px-3 py-2">
                  <span className={`inline-flex items-center gap-1 text-[11px] border rounded px-2 py-0.5 ${STATUS_STYLE[r.status]}`}>
                    {r.status === 'approved' ? <ShieldCheck className="w-3 h-3" /> : r.status === 'submitted' ? <CheckCircle className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
                    {r.status}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-1">
                    <button onClick={() => setPrinting(r)} className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded" title="Print report" aria-label={`Print ${r.reportNo || r.date}`}>
                      <Printer className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => {
                        localStorage.setItem('contractoros_gantt_focus', String(r.items[0]?.boqCode || ''));
                        onNavigate?.('gantt');
                      }}
                      className="p-1.5 text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 rounded"
                      title="Open first activity in Gantt"
                      aria-label={`Open ${r.reportNo || r.date} in Gantt`}
                    >
                      <ExternalLink className="w-4 h-4" />
                    </button>
                    <button onClick={() => openReport(r)} className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded" title={canEdit(r) ? 'Edit' : 'View'} aria-label={`${canEdit(r) ? 'Edit' : 'View'} ${r.reportNo || r.date}`}>
                      <Edit3 className="w-4 h-4" />
                    </button>
                    <button onClick={() => removeReport(r)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded" title="Delete" aria-label={`Delete ${r.reportNo || r.date}`}>
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-gray-400">
                  No reports for this month. Create today's report to start measuring progress.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Editor */}
      <DsrEditor
        report={editing}
        onChange={(r) => setEditing(r)}
        onClose={() => {
          // While a save is moving files, closing would reopen the editor when
          // the await resolves. Wait for the save to finish.
          if (!saving) setEditing(null);
        }}
        onSave={save}
        existing={reports.filter((r) => r.id !== editing?.id)}
        boq={boq}
        attendance={laborData}
        errors={validation.errors}
        warnings={validation.warnings}
        saving={saving}
        onAttach={attachDocs}
        onDetach={detachDoc}
        onOpenInVault={openInVault}
      />

      {/* Reopen control for a locked report */}
      {editing && editing.status === 'approved' && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] bg-white border border-rose-200 shadow-xl rounded-xl px-4 py-3 flex items-center gap-2 text-xs">
          <AlertTriangle className="w-4 h-4 text-rose-600" />
          <span>Approved report — locked.</span>
          <input
            value={reopenReason}
            onChange={(e) => setReopenReason(e.target.value)}
            placeholder="Reason to reopen"
            className="border border-gray-200 rounded px-2 py-1"
            aria-label="Reopen reason"
          />
          <button onClick={doReopen} className="px-2 py-1 rounded bg-rose-600 text-white font-medium">Reopen</button>
          <button onClick={() => setEditing(null)} className="px-2 py-1 rounded text-gray-500">Close</button>
        </div>
      )}

      {/* Print sheet */}
      <Modal
        isOpen={Boolean(printing)}
        onClose={() => setPrinting(null)}
        size="full"
        title={printing ? `Daily Site Report ${printing.reportNo || ''}` : ''}
        description="What prints — taken from the stored report."
      >
        {printing && (
          <div className="space-y-3">
            <div className="flex justify-end gap-2 no-print">
              <button
                onClick={() =>
                  void printSheet(printRef.current, {
                    title: `DSR ${printing?.reportNo || printing?.date || ''}`.trim(),
                  })
                }
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-gray-900 hover:bg-gray-800 rounded-lg"
                data-testid="dsr-print"
              >
                <Printer className="w-4 h-4" /> Print / PDF
              </button>
              <button onClick={() => setPrinting(null)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600">
                <X className="w-4 h-4" /> Close
              </button>
            </div>
            <div ref={printRef}>
              <DsrSheet report={printing} allReports={reports} boq={boq} />
            </div>
          </div>
        )}
      </Modal>

      {/* Recently deleted */}
      <Modal isOpen={showDeleted} onClose={() => setShowDeleted(false)} size="lg" title="Recently deleted reports" description="Restore a report and its quantities count again.">
        <div className="space-y-2">
          {(deleted || []).map((r) => (
            <div key={r.id} className="border border-gray-200 rounded-lg p-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{bsDate(r)} · <span className="font-mono text-xs">{r.reportNo || r.id}</span></p>
                <p className="text-xs text-gray-500 truncate">{r.items.map((i) => i.boqCode || i.description).join(', ') || 'No work item'}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={() => restore(r)} className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1">
                  <Undo2 className="w-3.5 h-3.5" /> Restore
                </button>
                <button
                  onClick={() => void purgeReport(r)}
                  className="p-1.5 text-gray-400 hover:text-red-600"
                  aria-label={`Delete permanently ${r.reportNo || r.date}`}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
          {(deleted || []).length === 0 && <p className="text-sm text-gray-400">Nothing deleted.</p>}
        </div>
      </Modal>
    </div>
  );
}
