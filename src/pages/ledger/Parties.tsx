// Parties (S4.3) — list with total payable/receivable + aging buckets
// 0-30 / 31-60 / 61+; click → statement with bills, payments, bill_links
// settlements and a running balance. Balances = Σ of that party's lines.
import { useState } from 'react';
import { ChevronLeft, Users } from 'lucide-react';
import { formatCurrency, cn } from '../../utils';
import { type Period, parties, partyStatement } from '../../services/booksService';
import { TYPE_LABEL } from './Feed';

export default function Parties({ period, version }: { period: Period; version: number }) {
  void version;
  const rows = parties(period);
  const [selected, setSelected] = useState<string | null>(null);

  if (selected) {
    const row = rows.find((r) => r.party_id === selected);
    const statement = partyStatement(selected);
    return (
      <div className="space-y-3" data-testid="party-statement">
        <div className="flex items-center justify-between">
          <button className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900" onClick={() => setSelected(null)}>
            <ChevronLeft className="w-4 h-4" /> All parties
          </button>
          <div className="text-sm space-x-4">
            <span className="text-gray-500">Receivable <b className="text-gray-900 tabular-nums">{formatCurrency(row?.receivable || 0)}</b></span>
            <span className="text-gray-500">Payable <b className="text-gray-900 tabular-nums">{formatCurrency(row?.payable || 0)}</b></span>
          </div>
        </div>
        <div className="border border-gray-200 rounded-xl overflow-hidden bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="text-left px-4 py-2">Date</th>
                <th className="text-left px-4 py-2">Voucher</th>
                <th className="text-left px-4 py-2">Type</th>
                <th className="text-left px-4 py-2">Detail</th>
                <th className="text-right px-4 py-2">Billed</th>
                <th className="text-right px-4 py-2">Settled</th>
                <th className="text-right px-4 py-2">Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {statement.length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400">No lines for this party.</td></tr>}
              {statement.map((r, i) => (
                <tr key={`${r.voucher}-${i}`}>
                  <td className="px-4 py-2 whitespace-nowrap text-gray-600">{r.ad_date}</td>
                  <td className="px-4 py-2 font-mono text-xs">{r.voucher}</td>
                  <td className="px-4 py-2">{TYPE_LABEL(r.type)}</td>
                  <td className="px-4 py-2 text-gray-600">{r.label}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{r.debit ? formatCurrency(r.debit) : ''}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{r.credit ? formatCurrency(r.credit) : ''}</td>
                  <td className="px-4 py-2 text-right tabular-nums font-medium">{formatCurrency(r.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {row && row.openBills.length > 0 && (
          <div className="border border-gray-200 rounded-xl bg-white p-4">
            <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-2">Open bills & aging</p>
            <ul className="text-sm divide-y divide-gray-100">
              {row.openBills.map((b) => (
                <li key={b.id} className="py-1.5 flex justify-between">
                  <span className="font-mono text-xs text-gray-600">{b.id} · due {b.due}</span>
                  <span className="tabular-nums">{formatCurrency(b.outstanding)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden bg-white">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-xs uppercase text-gray-500">
          <tr>
            <th className="text-left px-4 py-2">Party</th>
            <th className="text-right px-4 py-2">Receivable</th>
            <th className="text-right px-4 py-2">Payable</th>
            <th className="text-right px-4 py-2">0–30</th>
            <th className="text-right px-4 py-2">31–60</th>
            <th className="text-right px-4 py-2">61+</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.length === 0 && (
            <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400" data-testid="parties-empty"><Users className="w-5 h-5 mx-auto mb-1 opacity-50" />No parties yet.</td></tr>
          )}
          {rows.map((r) => (
            <tr key={r.party_id} className="cursor-pointer hover:bg-gray-50" onClick={() => setSelected(r.party_id)} data-testid={`party-${r.party_id}`}>
              <td className="px-4 py-2.5 font-medium text-gray-900">{r.party_id}</td>
              <td className="px-4 py-2.5 text-right tabular-nums text-emerald-700" data-testid={`party-ar-${r.party_id}`}>{r.receivable ? formatCurrency(r.receivable) : ''}</td>
              <td className="px-4 py-2.5 text-right tabular-nums text-rose-700" data-testid={`party-ap-${r.party_id}`}>{r.payable ? formatCurrency(r.payable) : ''}</td>
              <td className={cn('px-4 py-2.5 text-right tabular-nums', r.aging.b0_30 ? 'text-gray-800' : 'text-gray-300')}>{formatCurrency(r.aging.b0_30)}</td>
              <td className={cn('px-4 py-2.5 text-right tabular-nums', r.aging.b31_60 ? 'text-amber-700' : 'text-gray-300')}>{formatCurrency(r.aging.b31_60)}</td>
              <td className={cn('px-4 py-2.5 text-right tabular-nums', r.aging.b61 ? 'text-rose-700' : 'text-gray-300')}>{formatCurrency(r.aging.b61)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
