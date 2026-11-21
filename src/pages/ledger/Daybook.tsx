// Daybook (S4.2) — cash/bank lines only; columns date, voucher, type, party,
// account, in, out; running balance with a Cash/Bank account toggle.
import { formatCurrency, cn } from '../../utils';
import { bsLabelFromInts } from '../../services/periods';
import { type Period, daybook } from '../../services/booksService';
import { TYPE_LABEL } from './Feed';

export default function Daybook({
  period,
  account,
  setAccount,
  version,
}: {
  period: Period;
  account: 'cash' | 'bank';
  setAccount: (a: 'cash' | 'bank') => void;
  version: number;
}) {
  void version;
  const { opening, rows, closing } = daybook(account, period);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden" role="tablist" aria-label="Daybook account">
          {(['cash', 'bank'] as const).map((a) => (
            <button
              key={a}
              role="tab"
              aria-selected={account === a}
              data-testid={`daybook-toggle-${a}`}
              onClick={() => setAccount(a)}
              className={cn('px-4 py-1.5 text-sm font-medium capitalize', account === a ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50')}
            >
              {a}
            </button>
          ))}
        </div>
        <div className="text-xs text-gray-500 space-x-4">
          <span>Opening <b className="text-gray-800 tabular-nums">{formatCurrency(opening)}</b></span>
          <span>Closing <b className="text-gray-800 tabular-nums" data-testid="daybook-closing">{formatCurrency(closing)}</b></span>
        </div>
      </div>

      <div className="border border-gray-200 rounded-xl overflow-hidden bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-500">
            <tr>
              <th className="text-left px-4 py-2">Date</th>
              <th className="text-left px-4 py-2">Voucher</th>
              <th className="text-left px-4 py-2">Type</th>
              <th className="text-left px-4 py-2">Party</th>
              <th className="text-left px-4 py-2">Account</th>
              <th className="text-right px-4 py-2">In</th>
              <th className="text-right px-4 py-2">Out</th>
              <th className="text-right px-4 py-2">Balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-400 text-sm" data-testid="daybook-empty">No {account} movement in this period.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={`${r.voucher}-${r.ad_date}`} data-testid={`daybook-row-${r.voucher}`}>
                <td className="px-4 py-2 whitespace-nowrap">
                  <span className="block text-gray-800">{bsLabelFromInts(r.bs_y, r.bs_m, r.bs_d)}</span>
                  <span className="block text-[11px] text-gray-400">{r.ad_date}</span>
                </td>
                <td className="px-4 py-2 font-mono text-xs">{r.voucher}</td>
                <td className="px-4 py-2">{TYPE_LABEL(r.type)}</td>
                <td className="px-4 py-2">{r.party || '—'}</td>
                <td className="px-4 py-2 capitalize">{r.account}</td>
                <td className="px-4 py-2 text-right tabular-nums text-emerald-600">{r.in ? formatCurrency(r.in) : ''}</td>
                <td className="px-4 py-2 text-right tabular-nums text-rose-600">{r.out ? formatCurrency(r.out) : ''}</td>
                <td className="px-4 py-2 text-right tabular-nums font-medium">{formatCurrency(r.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
