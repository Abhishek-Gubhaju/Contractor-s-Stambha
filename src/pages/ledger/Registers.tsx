// ============================================================================
// Registers — the purchase and sales books a contractor files against.
//
// VAT-registered firms file a purchase register and a sales register each
// period (the IRD's Annex-13 style listing): serial, date, party and PAN, the
// supplier's own bill number, taxable value, VAT and total. These are derived
// from the same entry lines as everything else, never re-typed, so a register
// can never disagree with the ledger or with the printed bills.
//
// The register is its own printable sheet (printService clones it) and has CSV
// for the accountant.
// ============================================================================
import { useMemo } from 'react';
import { Printer, Download } from 'lucide-react';
import { formatCurrency } from '../../utils';
import { formatBS } from '../../utils/nepaliDate';
import { allEntries, linesOf, type Entry, type Period, type EntryType } from '../../services/booksService';
import { partyByName } from '../../services/partyService';
import { loadCompany } from '../../services/companyService';
import { usePrintTarget } from '../../hooks/usePrintTarget';
import { printSheet } from '../../services/print/printService';

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

const PURCHASE: EntryType[] = ['supplier-bill', 'purchase-return'];
const SALES: EntryType[] = ['client-invoice', 'credit-note'];

export interface Row {
  date: string;
  bs: string;
  voucher: string;
  type: EntryType;
  party: string;
  pan: string;
  ref: string;
  taxable: number;
  vat: number;
  total: number;
  tds: number;
  reversed: boolean;
}

export function buildRows(kind: 'purchase' | 'sales', period: Period): Row[] {
  const types = kind === 'purchase' ? PURCHASE : SALES;
  const reversedIds = new Set(allEntries().map((e) => e.reversal_of).filter(Boolean) as string[]);
  const rows: Row[] = [];
  for (const e of allEntries()) {
    if (!types.includes(e.type)) continue;
    if (e.bs_y !== period.year || e.bs_m !== period.month) continue;
    const lines = linesOf(e.id);
    const party = lines.find((l) => l.party_id)?.party_id || '';
    const pan = e.party_pan || partyByName(party)?.pan || '';
    const vat = round2(
      lines.reduce(
        (s, l) =>
          s +
          (l.account_id === 'acc:vat-input' ? l.debit - l.credit : 0) +
          (l.account_id === 'acc:vat-output' ? l.credit - l.debit : 0),
        0
      )
    );
    const taxable = round2(
      lines
        .filter((l) => l.account_id.startsWith('acc:exp:') || l.account_id === 'acc:income')
        .reduce((s, l) => s + Math.abs(l.debit - l.credit), 0)
    );
    const tds = round2(lines.filter((l) => l.account_id === 'acc:tds-payable').reduce((s, l) => s + l.credit - l.debit, 0));
    rows.push({
      date: e.ad_date,
      bs: formatBS({ year: e.bs_y, month: e.bs_m, day: e.bs_d }),
      voucher: e.id,
      type: e.type,
      party,
      pan,
      ref: e.ref,
      taxable,
      vat,
      total: round2(taxable + vat),
      tds,
      reversed: reversedIds.has(e.id),
    });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.voucher.localeCompare(b.voucher));
}

function downloadCsv(name: string, rows: Row[]) {
  const head = ['SN', 'AD date', 'BS date', 'Voucher', 'Type', 'Party', 'PAN', 'Bill/Ref', 'Taxable', 'VAT', 'Total', 'TDS'];
  const body = rows.map((r, i) => [
    String(i + 1),
    r.date,
    r.bs,
    r.voucher,
    r.type,
    r.party,
    r.pan,
    r.ref,
    String(r.taxable),
    String(r.vat),
    String(r.total),
    String(r.tds),
  ]);
  const csv = [head, ...body].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function Registers({ period, kind, setKind }: { period: Period; kind: 'purchase' | 'sales'; setKind: (k: 'purchase' | 'sales') => void }) {
  const company = loadCompany();
  const rows = useMemo(() => buildRows(kind, period), [kind, period.year, period.month]);
  const total = (key: keyof Row) =>
    round2(rows.filter((r) => !r.reversed).reduce((s, r) => s + (Number(r[key]) || 0), 0));
  const filename = `${kind}-register-${period.year}-${String(period.month).padStart(2, '0')}.csv`;
  const registerTitle = `${kind === 'purchase' ? 'Purchase' : 'Sales'} Register ${period.year}/${String(period.month).padStart(2, '0')}`;
  const printRef = usePrintTarget<HTMLDivElement>({ title: registerTitle, landscape: true });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 no-print">
        <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden">
          <button
            type="button"
            onClick={() => setKind('purchase')}
            className={`px-3 py-1.5 text-sm ${kind === 'purchase' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
            data-testid="register-purchase"
          >
            Purchase register
          </button>
          <button
            type="button"
            onClick={() => setKind('sales')}
            className={`px-3 py-1.5 text-sm ${kind === 'sales' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
            data-testid="register-sales"
          >
            Sales register
          </button>
        </div>
        <button
          type="button"
          onClick={() => downloadCsv(filename, rows)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-lg"
          data-testid="register-csv"
        >
          <Download className="w-4 h-4" /> CSV
        </button>
        <button
          type="button"
          onClick={() => void printSheet(printRef.current, { title: registerTitle, landscape: true })}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-gray-900 hover:bg-gray-800 rounded-lg"
          data-testid="register-print"
        >
          <Printer className="w-4 h-4" /> Print
        </button>
        <span className="text-xs text-gray-500">
          {rows.length} document{rows.length === 1 ? '' : 's'} in the period
        </span>
      </div>

      <div ref={printRef} className="bg-white border border-gray-200 rounded-lg p-6 text-sm" data-testid="register-sheet">
        <div className="flex items-start justify-between border-b-2 border-gray-800 pb-2 mb-3">
          <div>
            <p className="text-base font-bold">{company.name || 'Your company name'}</p>
            <p className="text-xs text-gray-600">{company.address}</p>
            <p className="text-xs text-gray-600">
              {company.pan && <>PAN: {company.pan}</>}
              {company.pan && company.vatNo && ' · '}
              {company.vatNo && <>VAT No: {company.vatNo}</>}
            </p>
          </div>
          <div className="text-right">
            <p className="font-bold uppercase">{kind === 'purchase' ? 'Purchase Register' : 'Sales Register'}</p>
            <p className="text-xs">Period: {period.year} / {String(period.month).padStart(2, '0')} (B.S.)</p>
          </div>
        </div>

        <table className="w-full text-[11px] border-collapse">
          <thead>
            <tr className="border-y border-gray-300 bg-gray-50">
              <th className="px-1.5 py-1 text-left w-7">SN</th>
              <th className="px-1.5 py-1 text-left">Date (B.S.)</th>
              <th className="px-1.5 py-1 text-left">Voucher</th>
              <th className="px-1.5 py-1 text-left">Party</th>
              <th className="px-1.5 py-1 text-left">PAN</th>
              <th className="px-1.5 py-1 text-left">Bill / Ref</th>
              <th className="px-1.5 py-1 text-right">Taxable</th>
              <th className="px-1.5 py-1 text-right">VAT</th>
              <th className="px-1.5 py-1 text-right">Total</th>
              {kind === 'purchase' && <th className="px-1.5 py-1 text-right">TDS</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.voucher} className={`border-b border-gray-100 ${r.reversed ? 'text-gray-400 line-through' : ''}`}>
                <td className="px-1.5 py-1">{i + 1}</td>
                <td className="px-1.5 py-1">{r.bs}</td>
                <td className="px-1.5 py-1 font-mono">{r.voucher}</td>
                <td className="px-1.5 py-1">{r.party || '—'}</td>
                <td className="px-1.5 py-1 font-mono">{r.pan || '—'}</td>
                <td className="px-1.5 py-1">{r.ref || '—'}</td>
                <td className="px-1.5 py-1 text-right tabular-nums">{formatCurrency(r.taxable)}</td>
                <td className="px-1.5 py-1 text-right tabular-nums">{formatCurrency(r.vat)}</td>
                <td className="px-1.5 py-1 text-right tabular-nums">{formatCurrency(r.total)}</td>
                {kind === 'purchase' && <td className="px-1.5 py-1 text-right tabular-nums">{formatCurrency(r.tds)}</td>}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={kind === 'purchase' ? 10 : 9} className="px-2 py-6 text-center text-gray-400">
                  Nothing posted in this period.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-gray-800 font-semibold">
              <td className="px-1.5 py-1" colSpan={6}>Total</td>
              <td className="px-1.5 py-1 text-right tabular-nums">{formatCurrency(total('taxable'))}</td>
              <td className="px-1.5 py-1 text-right tabular-nums">{formatCurrency(total('vat'))}</td>
              <td className="px-1.5 py-1 text-right tabular-nums">{formatCurrency(total('total'))}</td>
              {kind === 'purchase' && <td className="px-1.5 py-1 text-right tabular-nums">{formatCurrency(total('tds'))}</td>}
            </tr>
          </tfoot>
        </table>
        <p className="mt-2 text-[10px] text-gray-500">
          Reversed documents are struck through and excluded from the totals. Figures come from the posted entry lines.
        </p>
      </div>
    </div>
  );
}
