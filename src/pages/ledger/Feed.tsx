// Feed (S4.1) — entry history: type icon, local+AD date, ref, party, amount,
// routing badges, source badge, lock icon; click → drawer with generated lines.
import { Receipt, FileText, Banknote, Download, Upload, ArrowLeftRight, Landmark, Scale, UserRound, Lock, CircleDollarSign, Undo2, PackagePlus, PackageMinus } from 'lucide-react';
import { formatCurrency, cn } from '../../utils';
import { bsLabelFromInts } from '../../services/periods';
import { type EntryType, type Period, feed } from '../../services/booksService';

const TYPE_META: Record<EntryType, { label: string; icon: React.ReactNode }> = {
  'supplier-bill': { label: 'Supplier Bill', icon: <FileText className="w-4 h-4" /> },
  'payment-supplier': { label: 'Supplier Payment', icon: <Download className="w-4 h-4" /> },
  'client-receipt': { label: 'Client Receipt', icon: <Banknote className="w-4 h-4" /> },
  'client-invoice': { label: 'Client Invoice', icon: <Upload className="w-4 h-4" /> },
  'client-advance': { label: 'Client Advance', icon: <Banknote className="w-4 h-4" /> },
  'opening-balance': { label: 'Opening Balance', icon: <Landmark className="w-4 h-4" /> },
  'expense-paid': { label: 'Expense', icon: <Receipt className="w-4 h-4" /> },
  'worker-advance': { label: 'Worker Advance', icon: <UserRound className="w-4 h-4" /> },
  transfer: { label: 'Transfer', icon: <ArrowLeftRight className="w-4 h-4" /> },
  'owner-loan-in': { label: 'Owner / Loan In', icon: <Landmark className="w-4 h-4" /> },
  adjustment: { label: 'Adjustment', icon: <Scale className="w-4 h-4" /> },
  'payroll-accrual': { label: 'Payroll Accrual', icon: <CircleDollarSign className="w-4 h-4" /> },
  'payroll-payment': { label: 'Payroll Payment', icon: <CircleDollarSign className="w-4 h-4" /> },
  reversal: { label: 'Reversal', icon: <Undo2 className="w-4 h-4" /> },
  'stock-receipt': { label: 'Stock Received', icon: <PackagePlus className="w-4 h-4" /> },
  'stock-issue': { label: 'Stock Issued', icon: <PackageMinus className="w-4 h-4" /> },
  'stock-adjust': { label: 'Stock Adjustment', icon: <Scale className="w-4 h-4" /> },
  'purchase-return': { label: 'Purchase Return (Debit Note)', icon: <PackageMinus className="w-4 h-4" /> },
  'credit-note': { label: 'Credit Note', icon: <Undo2 className="w-4 h-4" /> },
  receipt: { label: 'Receipt (migrated)', icon: <Receipt className="w-4 h-4" /> },
  payment: { label: 'Payment (migrated)', icon: <Receipt className="w-4 h-4" /> },
  journal: { label: 'Journal (migrated)', icon: <Scale className="w-4 h-4" /> },
};

export const TYPE_LABEL = (t: EntryType) => TYPE_META[t]?.label || t;

const SOURCE_STYLE: Record<string, string> = {
  manual: 'bg-gray-100 text-gray-600 border-gray-200',
  payroll: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  billing: 'bg-amber-50 text-amber-700 border-amber-200',
};

export default function Feed({ period, onOpen, version }: { period: Period; onOpen: (id: string) => void; version: number }) {
  const rows = feed(period);
  void version;
  if (rows.length === 0) {
    return (
      <div className="text-center py-16 text-gray-400" data-testid="feed-empty">
        <Receipt className="w-8 h-8 mx-auto mb-2 opacity-50" />
        <p className="text-sm">No entries in this period yet — press <kbd className="px-1.5 py-0.5 border border-gray-300 rounded text-xs">C</kbd> or use ＋ New Entry.</p>
      </div>
    );
  }
  return (
    <div className="divide-y divide-gray-100 border border-gray-200 rounded-xl overflow-hidden bg-white" data-testid="feed-list">
      {rows.map((r) => {
        const meta = TYPE_META[r.entry.type] || TYPE_META.journal;
        return (
          <button
            key={r.entry.id}
            type="button"
            onClick={() => onOpen(r.entry.id)}
            className="w-full text-left px-4 py-3 flex items-center gap-4 hover:bg-gray-50 transition-colors"
            data-testid={`feed-row-${r.entry.id}`}
          >
            <span className="w-8 h-8 rounded-lg bg-gray-100 text-gray-600 flex items-center justify-center shrink-0">{meta.icon}</span>
            <span className="w-40 shrink-0">
              <span className="block text-sm font-medium text-gray-900 truncate">{r.party || TYPE_LABEL(r.entry.type)}</span>
              <span className="block text-xs text-gray-400 truncate">
                {r.entry.ref ? `${r.entry.ref} · ${r.entry.id}` : r.entry.id}
              </span>
            </span>
            <span className="w-32 shrink-0 text-xs text-gray-500">
              <span className="block text-gray-700">{bsLabelFromInts(r.entry.bs_y, r.entry.bs_m, r.entry.bs_d)}</span>
              <span className="block text-gray-400">{r.entry.ad_date}</span>
            </span>
            <span className="flex-1 flex flex-wrap gap-1 min-w-0">
              {r.accounts.map((a) => (
                <span key={a} className="text-[11px] bg-blue-50 text-blue-700 border border-blue-100 rounded px-1.5 py-0.5">{a}</span>
              ))}
            </span>
            <span className={cn('text-[11px] border rounded px-1.5 py-0.5 shrink-0', SOURCE_STYLE[r.entry.source] || SOURCE_STYLE.manual)}>
              {r.entry.source}
            </span>
            {r.reversed && (
              <span className="text-[11px] text-rose-700 bg-white border border-gray-200 border-l-2 border-l-red-600 rounded px-1.5 py-0.5 shrink-0">reversed</span>
            )}
            {r.locked && <Lock className="w-3.5 h-3.5 text-gray-400 shrink-0" data-testid={`feed-lock-${r.entry.id}`} />}
            <span className="w-28 text-right text-sm font-semibold text-gray-900 tabular-nums shrink-0">{formatCurrency(r.amount)}</span>
          </button>
        );
      })}
    </div>
  );
}
