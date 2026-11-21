// Statements (S4.5) — per-account statement (opening/in/out/closing) for
// cash & bank; category summary; trial-balance indicator (ΣDr = ΣCr,
// green/red) ALWAYS visible; red trial balance shows a blocking banner.
import { useState } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { formatCurrency, cn } from '../../utils';
import { bsLabelFromInts } from '../../services/periods';
import { type Period, accountStatement, categorySummary, trialBalance } from '../../services/booksService';
import { TYPE_LABEL } from './Feed';
import { TransactionDetail } from './TransactionDetail';

function AccountCard({ account, period, onInfo }: { account: 'cash' | 'bank'; period: Period; onInfo: (voucher: string) => void }) {
  const { opening, rows, closing } = accountStatement(account, period);
  const inflow = rows.reduce((s, r) => s + r.in, 0);
  const outflow = rows.reduce((s, r) => s + r.out, 0);
  return (
    <div className="border border-gray-200 rounded-xl bg-white overflow-hidden" data-testid={`statement-${account}`}>
      <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 border-b border-gray-100">
        <p className="text-sm font-semibold text-gray-900 capitalize">{account} statement</p>
        <div className="text-xs text-gray-500 space-x-3">
          <span>open <b className="text-gray-800 tabular-nums">{formatCurrency(opening)}</b></span>
          <span className="text-emerald-700">+{formatCurrency(inflow)}</span>
          <span className="text-rose-700">−{formatCurrency(outflow)}</span>
          <span>close <b className="text-gray-800 tabular-nums" data-testid={`statement-closing-${account}`}>{formatCurrency(closing)}</b></span>
        </div>
      </div>
      <table className="w-full text-sm">
        <tbody className="divide-y divide-gray-100">
          {rows.length === 0 && <tr><td className="px-4 py-5 text-center text-gray-400 text-xs">No movement this period.</td></tr>}
          {rows.map((r, i) => (
            <tr key={`${r.voucher}-${i}`}>
              <td className="px-4 py-1.5 whitespace-nowrap text-xs text-gray-500">
                <span className="block text-gray-700">{bsLabelFromInts(r.bs_y, r.bs_m, r.bs_d)}</span>
                <span>{r.ad_date}</span>
              </td>
              <td className="px-2 py-1.5 font-mono text-xs">{r.voucher}</td>
              <td className="px-2 py-1.5 text-xs">{TYPE_LABEL(r.type)}</td>
              <td className="px-2 py-1.5 text-xs text-gray-600">{r.party || '—'}</td>
              <td className="px-2 py-1.5 text-right tabular-nums text-xs text-emerald-700">{r.in ? formatCurrency(r.in) : ''}</td>
              <td className="px-2 py-1.5 text-right tabular-nums text-xs text-rose-700">{r.out ? formatCurrency(r.out) : ''}</td>
              <td className="px-4 py-1.5 text-right tabular-nums text-xs font-medium">{formatCurrency(r.balance)}</td>
              <td className="px-1 py-1.5 text-right w-7">
                <button
                  type="button"
                  onClick={() => onInfo(r.voucher)}
                  className="p-1 rounded text-gray-400 hover:text-blue-700 hover:bg-blue-50"
                  aria-label={`Transaction details for ${r.voucher}`}
                  title="Transaction details"
                  data-testid={`info-${account}`}
                >
                  <Info className="w-3.5 h-3.5" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Statements({ period, version }: { period: Period; version: number }) {
  void version;
  const [detailId, setDetailId] = useState<string | null>(null);
  const tb = trialBalance();
  const categories = categorySummary(period);

  return (
    <div className="space-y-4">
      {/* Trial balance indicator — ALWAYS visible (S4.5) */}
      <div
        className={cn('flex items-center justify-between px-4 py-3 rounded-xl border', tb.balanced ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-300')}
        data-testid="trial-balance"
        data-balanced={String(tb.balanced)}
      >
        <div className="flex items-center gap-2 text-sm">
          <span className={cn('w-2.5 h-2.5 rounded-full', tb.balanced ? 'bg-emerald-500' : 'bg-red-600')} />
          <span className="font-semibold text-gray-900">Trial balance: {tb.balanced ? 'Σ Dr = Σ Cr ✓ green' : 'RED — Σ Dr ≠ Σ Cr'}</span>
        </div>
        <div className="text-sm text-gray-600 tabular-nums space-x-4" data-testid="trial-balance-totals">
          <span>Σ Dr {formatCurrency(tb.totalDebit)}</span>
          <span>Σ Cr {formatCurrency(tb.totalCredit)}</span>
          <span className={tb.balanced ? 'text-emerald-700' : 'text-red-700'}>Δ {formatCurrency(tb.difference)}</span>
        </div>
      </div>

      {!tb.balanced && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-xl border border-red-300 bg-red-50 text-sm text-red-700" data-testid="tb-banner" role="alert">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          Trial balance is red — exports are blocked until Σ Dr = Σ Cr.
        </div>
      )}

      <div className="grid xl:grid-cols-2 gap-4">
        <AccountCard account="cash" period={period} onInfo={setDetailId} />
        <AccountCard account="bank" period={period} onInfo={setDetailId} />
      </div>

      <TransactionDetail entryId={detailId} onClose={() => setDetailId(null)} />

      <div className="border border-gray-200 rounded-xl bg-white overflow-hidden" data-testid="category-summary">
        <p className="px-4 py-2.5 bg-gray-50 border-b border-gray-100 text-sm font-semibold text-gray-900">Category summary</p>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-gray-100">
            {categories.length === 0 && <tr><td className="px-4 py-5 text-center text-gray-400 text-xs">No expense lines this period.</td></tr>}
            {categories.map((c) => (
              <tr key={c.category}>
                <td className="px-4 py-2">{c.category}</td>
                <td className="px-4 py-2 text-right tabular-nums font-medium">{formatCurrency(c.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
