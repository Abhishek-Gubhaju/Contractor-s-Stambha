// ============================================================================
// Ledger — FULL REPLACEMENT (Section 0 done: the 15-field form, All/Debits/
// Credits tabs, category statement card and old opening-balance flow are gone).
//
// The page is now a thin shell over read-only views that ALL derive from
// entry_lines (S0.4):
//
//   ControlsBar  period · lock · openings · exports · parity + reconciliation
//   Tabs         Feed | Daybook | Parties | Job Cost | Statements (S4)
//   Hopper       the single entry point — global ＋ / shortcut C (S2.1)
//   Drawer       click a Feed row → generated lines; edit or jump to source
//
// Everything is offline (S6.4); the legacy table is only read by the
// migration that runs on mount (S1).
// ============================================================================
import { useEffect, useState, useCallback } from 'react';
import { Plus, X, Pencil, ExternalLink, Paperclip, Undo2, Printer } from 'lucide-react';
import { Modal, Tabs } from '../components/ui';
import { TabsList, TabsTrigger, TabsContent } from '../components/ui/Tabs';
import { formatCurrency, cn } from '../utils';
import { getTodayBS, formatBS } from '../utils/nepaliDate';
import {
  entryById,
  linesOf,
  isEditable,
  jumpTarget,
  accountName,
  formForEntry,
  trialBalance,
  isReversed,
  reverseEntry,
  type Entry,
  type EntryType,
  type Period,
} from '../services/booksService';
import { runMigration } from '../services/ledgerMigration';
import { Hopper } from './ledger/Hopper';
import Feed from './ledger/Feed';
import Daybook from './ledger/Daybook';
import Parties from './ledger/Parties';
import JobCostView from './ledger/JobCostView';
import Statements from './ledger/Statements';
import ControlsBar from './ledger/ControlsBar';
import WipReport from './ledger/WipReport';
import DocumentView from './ledger/DocumentView';
import Registers from './ledger/Registers';
import { getActiveProject } from '../services/projectScope';
import { periodAdRange, periodKey } from '../services/periods';
import { loadCompany } from '../services/companyService';
import { usePrintTarget } from '../hooks/usePrintTarget';
import { TYPE_LABEL } from './ledger/Feed';
import { readAttachment } from '../services/ledgerService';

interface Props {
  onNavigate?: (page: string) => void;
}

export default function LedgerPage({ onNavigate }: Props) {
  const today = getTodayBS();
  const [period, setPeriod] = useState<Period>({ year: today.year, month: today.month });
  const [account, setAccount] = useState<'cash' | 'bank'>('cash');
  const [version, setVersion] = useState(0);
  const [hopper, setHopper] = useState<{ open: boolean; editingId: string | null; type: EntryType | null; form: Record<string, any> | null }>({ open: false, editingId: null, type: null, form: null });
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [docId, setDocId] = useState<string | null>(null);
  const [registerKind, setRegisterKind] = useState<'purchase' | 'sales'>('purchase');
  const [reverseReason, setReverseReason] = useState('');
  const [reverseError, setReverseError] = useState('');
  const [toast, setToast] = useState('');
  // What "PDF" and Cmd+P print: the open tab, with this job's letterhead.
  const ledgerPrintRef = usePrintTarget<HTMLDivElement>({
    title: `Ledger ${periodKey(period.year, period.month)}`,
    landscape: true,
  });
  const ledgerCompany = loadCompany();

  const bump = useCallback(() => setVersion((v) => v + 1), []);

  // S1: migrate legacy rows once (idempotent, parity-gated).
  useEffect(() => {
    const res = runMigration();
    if (res.ran && res.migrated > 0) setToast(`Migrated ${res.migrated} legacy entries — parity green.`);
    else if (res.error) setToast(res.error);
    bump();
  }, [bump]);

  // Global ＋ Capture / shortcut C from the Header (S2.1). If the header
  // navigated here from another page, the event fired before this mount —
  // consume the pending flag instead.
  useEffect(() => {
    const open = () => setHopper({ open: true, editingId: null, type: null, form: null });
    window.addEventListener('contractoros:open-hopper', open);
    const w = window as any;
    if (w.__ledgerHopperPending) {
      w.__ledgerHopperPending = false;
      open();
    }
    const changed = () => bump();
    window.addEventListener('contractoros:books-changed', changed);
    return () => {
      window.removeEventListener('contractoros:open-hopper', open);
      window.removeEventListener('contractoros:books-changed', changed);
    };
  }, [bump]);

  // "C" keyboard shortcut for New Entry — active only while on the Ledger page.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        setHopper({ open: true, editingId: null, type: null, form: null });
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const drawerEntry: Entry | null = drawerId ? entryById(drawerId) || null : null;
  const drawerLines = drawerEntry ? linesOf(drawerEntry.id) : [];
  const tb = trialBalance();

  const startEdit = (entry: Entry) => {
    const { type, form } = formForEntry(entry);
    setHopper({ open: true, editingId: entry.id, type, form });
    setDrawerId(null);
  };

  const jump = (entry: Entry) => {
    const target = jumpTarget(entry);
    if (target) onNavigate?.(target.page);
  };

  const openDrawer = (id: string) => {
    setDrawerId(id);
    setReverseReason('');
    setReverseError('');
  };

  const doReverse = () => {
    if (!drawerEntry) return;
    try {
      const rev = reverseEntry(drawerEntry.id, reverseReason);
      setReverseReason('');
      setReverseError('');
      setDrawerId(rev.id);
      setToast(`Reversal ${rev.id} posted — ${drawerEntry.id} now nets to zero.`);
      bump();
    } catch (e) {
      setReverseError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1>Ledger</h1>
          <p className="text-sm text-gray-500">Double-entry books — one line table, every view derived from it.</p>
          <p className="text-xs text-indigo-600 font-medium mt-1">
            B.S. Today: {formatBS(getTodayBS())} · Trial balance {tb.balanced ? '✓ green' : '✗ red'}
          </p>
        </div>
        <button
          className="inline-flex items-center gap-2 bg-gray-900 hover:bg-gray-800 text-white px-4 py-2 rounded-lg text-sm font-medium"
          onClick={() => setHopper({ open: true, editingId: null, type: null, form: null })}
          data-testid="capture-button"
        >
          <Plus className="w-4 h-4" /> New Entry <kbd className="text-[10px] bg-blue-500 rounded px-1">C</kbd>
        </button>
      </div>

      <ControlsBar period={period} setPeriod={setPeriod} version={version} />

      <div ref={ledgerPrintRef} className="bg-white rounded-xl border p-4" data-testid="ledger-sheet">
        <div className="flex items-start justify-between border-b-2 border-gray-800 pb-2 mb-3">
          <div>
            <p className="text-base font-bold">{ledgerCompany.name || 'Your company name'}</p>
            <p className="text-xs text-gray-600">
              {ledgerCompany.pan && <>PAN: {ledgerCompany.pan}</>}
              {ledgerCompany.pan && ledgerCompany.vatNo && ' · '}
              {ledgerCompany.vatNo && <>VAT No: {ledgerCompany.vatNo}</>}
            </p>
            <p className="text-xs text-gray-600">Job: {getActiveProject()}</p>
          </div>
          <div className="text-right">
            <p className="font-bold uppercase">Ledger</p>
            <p className="text-xs">Period: {periodKey(period.year, period.month)} (B.S.)</p>
            <p className="text-xs">
              A.D. {periodAdRange(period).from} → {periodAdRange(period).to}
            </p>
          </div>
        </div>
        <Tabs defaultValue="feed">
        <TabsList className="no-print">
          <TabsTrigger value="feed">Feed</TabsTrigger>
          <TabsTrigger value="daybook">Daybook</TabsTrigger>
          <TabsTrigger value="parties">Parties</TabsTrigger>
          <TabsTrigger value="jobcost">Job Cost</TabsTrigger>
          <TabsTrigger value="registers">Registers</TabsTrigger>
          <TabsTrigger value="wip">WIP</TabsTrigger>
          <TabsTrigger value="statements">Statements</TabsTrigger>
        </TabsList>

        <TabsContent value="feed" className="pt-4">
          <Feed period={period} version={version} onOpen={openDrawer} />
        </TabsContent>
        <TabsContent value="daybook" className="pt-4">
          <Daybook period={period} account={account} setAccount={setAccount} version={version} />
        </TabsContent>
        <TabsContent value="parties" className="pt-4">
          <Parties period={period} version={version} />
        </TabsContent>
        <TabsContent value="jobcost" className="pt-4">
          <JobCostView version={version} />
        </TabsContent>
        <TabsContent value="registers" className="pt-4">
          <Registers period={period} kind={registerKind} setKind={setRegisterKind} />
        </TabsContent>
        <TabsContent value="wip" className="pt-4">
          <WipReport to={periodAdRange(period).to} />
        </TabsContent>
        <TabsContent value="statements" className="pt-4">
          <Statements period={period} version={version} />
        </TabsContent>
        </Tabs>
      </div>

      <DocumentView entry={docId ? entryById(docId) || null : null} onClose={() => setDocId(null)} />

      {/* Drawer: generated lines for one entry (S4.1) */}
      <Modal
        isOpen={Boolean(drawerEntry)}
        onClose={() => setDrawerId(null)}
        size="lg"
        title={drawerEntry ? `${TYPE_LABEL(drawerEntry.type)} — ${drawerEntry.id}` : ''}
        description={drawerEntry ? `${formatBS({ year: drawerEntry.bs_y, month: drawerEntry.bs_m, day: drawerEntry.bs_d })} · AD ${drawerEntry.ad_date}` : ''}
      >
        {drawerEntry && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className={cn('border rounded px-2 py-0.5', drawerEntry.source === 'manual' ? 'bg-gray-50 text-gray-600 border-gray-200' : drawerEntry.source === 'payroll' ? 'bg-indigo-50 text-indigo-700 border-indigo-200' : 'bg-amber-50 text-amber-700 border-amber-200')} data-testid="drawer-source">
                {drawerEntry.source}
              </span>
              {drawerEntry.ref && <span className="text-gray-500">ref {drawerEntry.ref}</span>}
              {drawerEntry.note && <span className="text-gray-500">{drawerEntry.note}</span>}
              {drawerEntry.attachment && (
                <span className="inline-flex items-center gap-1 text-gray-500">
                  <Paperclip className="w-3 h-3" /> {drawerEntry.attachment.split('/').pop()}
                  <button
                    className="underline"
                    onClick={() => {
                      const data = readAttachment(drawerEntry.attachment);
                      if (data) window.open(data, '_blank');
                    }}
                  >
                    open
                  </button>
                </span>
              )}
              {drawerEntry.edited_history.length > 0 && (
                <span className="text-amber-700 bg-white border border-gray-200 border-l-2 border-l-amber-600 rounded px-2 py-0.5" data-testid="edit-history-count">
                  {drawerEntry.edited_history.length} edit{drawerEntry.edited_history.length > 1 ? 's' : ''} in history
                </span>
              )}
              {drawerEntry.due_date && (
                <span className="text-gray-500">due {drawerEntry.due_date}</span>
              )}
              {drawerEntry.reversal_of && (
                <span className="text-rose-700 bg-white border border-gray-200 border-l-2 border-l-red-600 rounded px-2 py-0.5" data-testid="drawer-is-reversal">
                  reverses {drawerEntry.reversal_of}
                </span>
              )}
              {isReversed(drawerEntry.id) && (
                <span className="text-rose-700 bg-white border border-gray-200 border-l-2 border-l-red-600 rounded px-2 py-0.5" data-testid="drawer-reversed">
                  reversed
                </span>
              )}
            </div>

            <div className="border border-gray-200 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                  <tr>
                    <th className="text-left px-4 py-2">Account</th>
                    <th className="text-left px-4 py-2">Party / Worker</th>
                    <th className="text-left px-4 py-2">Project</th>
                    <th className="text-left px-4 py-2">Memo</th>
                    <th className="text-right px-4 py-2">Debit</th>
                    <th className="text-right px-4 py-2">Credit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100" data-testid="drawer-lines">
                  {drawerLines.map((l) => (
                    <tr key={l.id}>
                      <td className="px-4 py-2">{accountName(l.account_id)}</td>
                      <td className="px-4 py-2">{l.party_id || (l.worker_id ? accountName(l.account_id) : '—')}</td>
                      <td className="px-4 py-2">{l.project_id || '—'}</td>
                      <td className="px-4 py-2 text-gray-500">{l.memo}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{l.debit ? formatCurrency(l.debit) : ''}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{l.credit ? formatCurrency(l.credit) : ''}</td>
                    </tr>
                  ))}
                  <tr className="bg-gray-50 font-medium">
                    <td className="px-4 py-2" colSpan={4}>Σ</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatCurrency(drawerLines.reduce((s, l) => s + l.debit, 0))}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatCurrency(drawerLines.reduce((s, l) => s + l.credit, 0))}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {drawerEntry.edited_history.length > 0 && (
              <div className="border border-gray-200 border-l-2 border-l-amber-600 bg-white rounded-xl p-3 text-xs text-amber-800" data-testid="edit-history">
                <p className="font-semibold mb-1">Previous versions</p>
                {drawerEntry.edited_history.slice().reverse().map((h, i) => (
                  <p key={i} className="truncate">
                    {new Date(h.at).toLocaleString()} — {h.reason} — was {formatCurrency(h.lines.reduce((s, l) => s + l.debit, 0))} Dr across {h.lines.length} lines
                  </p>
                ))}
              </div>
            )}

            {isEditable(drawerEntry) && drawerEntry.type !== 'reversal' && !isReversed(drawerEntry.id) && (
              <div className="border border-gray-200 border-l-2 border-l-red-600 bg-white rounded-xl p-3 space-y-2" data-testid="reverse-panel">
                <p className="text-xs font-semibold text-rose-800">Reverse this entry</p>
                <p className="text-[11px] text-rose-700">
                  A mirror entry is posted; the original stays in the history.
                </p>
                <div className="flex gap-2">
                  <input
                    className="flex-1 border border-rose-200 rounded-lg px-3 py-1.5 text-sm bg-white"
                    placeholder="Reason (required, recorded in audit)"
                    value={reverseReason}
                    onChange={(e) => setReverseReason(e.target.value)}
                    aria-label="Reversal reason"
                  />
                  <button
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-rose-600 hover:bg-rose-700 rounded-lg"
                    onClick={doReverse}
                    data-testid="reverse-confirm"
                  >
                    <Undo2 className="w-4 h-4" /> Reverse
                  </button>
                </div>
                {reverseError && (
                  <p className="text-xs text-red-700" role="alert" data-testid="reverse-error">{reverseError}</p>
                )}
              </div>
            )}

            <div className="flex justify-end gap-3 pt-2 border-t border-gray-100">
              <button
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-lg mr-auto"
                onClick={() => setDocId(drawerEntry.id)}
                data-testid="drawer-document"
              >
                <Printer className="w-4 h-4" /> Print document
              </button>
              {isEditable(drawerEntry) ? (
                <button className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-gray-900 hover:bg-gray-800 rounded-lg" onClick={() => startEdit(drawerEntry)} data-testid="drawer-edit">
                  <Pencil className="w-4 h-4" /> Edit
                </button>
              ) : (
                <button className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-indigo-700 bg-indigo-50 border border-indigo-200 hover:bg-indigo-100 rounded-lg" onClick={() => jump(drawerEntry)} data-testid="drawer-jump">
                  <ExternalLink className="w-4 h-4" /> {jumpTarget(drawerEntry)?.label || 'Open source'}
                </button>
              )}
              <button className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 inline-flex items-center gap-1" onClick={() => setDrawerId(null)}>
                <X className="w-4 h-4" /> Close
              </button>
            </div>
          </div>
        )}
      </Modal>

      <Hopper
        isOpen={hopper.open}
        onClose={() => setHopper((h) => ({ ...h, open: false }))}
        initialType={hopper.type}
        initialForm={hopper.form}
        editingId={hopper.editingId}
        onNavigate={onNavigate}
        onSaved={(entry, summary) => {
          setToast(summary);
          bump();
        }}
      />

      {toast && (
        <div className="fixed bottom-5 right-5 z-[1050] bg-gray-900 text-white text-sm rounded-xl shadow-xl px-4 py-3 max-w-md" data-testid="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
