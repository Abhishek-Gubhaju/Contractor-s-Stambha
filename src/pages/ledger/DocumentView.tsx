// ============================================================================
// DocumentView — the PRINTED format of an entry.
//
// A ledger entry is a journal; a contractor also has to hand the client or
// supplier a piece of paper. This renders the document from the entry as
// stored (never re-inventing figures):
//
//   • letterhead — company name, address, phone, PAN / VAT (Rule 17)
//   • document title — TAX INVOICE / PURCHASE BILL / DEBIT NOTE / CREDIT NOTE
//   • voucher no, the counterparty's own bill no (ref), AD + B.S. dates
//   • buyer block with PAN and address
//   • every item line (SN, description, unit, qty, rate, amount); entries
//     posted as a lump sum show one aggregated line rather than nothing
//   • subtotal → discount → taxable → VAT → TDS → retention → payable
//   • amount in words, signature and seal blocks, footer note
//
// This element is the print source: printService clones it, so the voucher on
// screen and the voucher on paper are the same markup.
// ============================================================================
import { useMemo } from 'react';
import { Printer, X } from 'lucide-react';
import { Modal } from '../../components/ui';
import { formatCurrency } from '../../utils';
import { formatBS } from '../../utils/nepaliDate';
import { loadCompany } from '../../services/companyService';
import { docItemsOf, amountInWords, type DocItem } from '../../services/documentService';
import { accountName, linesOf, type Entry, type EntryType } from '../../services/booksService';
import { usePrintTarget } from '../../hooks/usePrintTarget';
import { printSheet } from '../../services/print/printService';

const TITLES: Partial<Record<EntryType, { en: string; np: string }>> = {
  'supplier-bill': { en: 'PURCHASE BILL', np: 'खरिद बिजक' },
  'client-invoice': { en: 'TAX INVOICE', np: 'कर बिजक' },
  'purchase-return': { en: 'DEBIT NOTE', np: 'डेबिट नोट' },
  'credit-note': { en: 'CREDIT NOTE', np: 'क्रेडिट नोट' },
  'payment-supplier': { en: 'PAYMENT VOUCHER', np: 'भुक्तानी भौचर' },
  'client-receipt': { en: 'RECEIPT VOUCHER', np: 'रसिद भौचर' },
  'expense-paid': { en: 'EXPENSE VOUCHER', np: 'खर्च भौचर' },
  'worker-advance': { en: 'ADVANCE VOUCHER', np: 'पेश्‍गी भौचर' },
  transfer: { en: 'TRANSFER VOUCHER', np: 'स्थानान्तरण भौचर' },
  'owner-loan-in': { en: 'RECEIPT VOUCHER', np: 'रसिद भौचर' },
  adjustment: { en: 'JOURNAL VOUCHER', np: 'जर्नल भौचर' },
};

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export interface DocumentViewProps {
  entry: Entry | null;
  onClose: () => void;
}

export function DocumentView({ entry, onClose }: DocumentViewProps) {
  const company = loadCompany();

  const data = useMemo(() => {
    if (!entry) return null;
    const lines = linesOf(entry.id);
    const items: DocItem[] = docItemsOf(entry.id);

    // Figures come from the posted lines — the document cannot disagree with
    // the books, even if the item table was edited afterwards.
    const expense = round2(
      lines
        .filter((l) => l.account_id.startsWith('acc:exp:') || l.account_id === 'acc:inventory')
        .reduce((s, l) => s + l.debit - l.credit, 0)
    );
    const income = round2(lines.filter((l) => l.account_id === 'acc:income').reduce((s, l) => s + l.credit - l.debit, 0));
    const vat = round2(
      lines.reduce(
        (s, l) =>
          s +
          (l.account_id === 'acc:vat-input' ? l.debit - l.credit : 0) +
          (l.account_id === 'acc:vat-output' ? l.credit - l.debit : 0),
        0
      )
    );
    const tds = round2(lines.filter((l) => l.account_id === 'acc:tds-payable').reduce((s, l) => s + l.credit - l.debit, 0));
    const retention = round2(lines.filter((l) => l.account_id === 'acc:retention-ar').reduce((s, l) => s + l.debit - l.credit, 0));
    const cash = round2(
      lines.reduce((s, l) => s + (l.account_id === 'acc:cash' || l.account_id === 'acc:bank' ? l.debit - l.credit : 0), 0)
    );
    // Advance recovered on this bill: printed as a deduction, not hidden.
    const advanceRecovered = round2(lines.filter((l) => l.account_id === 'acc:advance-client').reduce((s, l) => s + l.debit - l.credit, 0));
    const party = lines.find((l) => l.party_id)?.party_id || '';
    const project = lines.find((l) => l.project_id)?.project_id || '';

    const base = expense || income;
    const total = round2(base + vat);
    const payable =
      entry.type === 'client-receipt' || entry.type === 'payment-supplier' || entry.type === 'expense-paid'
        ? Math.abs(cash)
        : round2(total - tds - retention - advanceRecovered);

    // A lump-sum posting has no item table: show the routing as one line.
    const rows: DocItem[] =
      items.length > 0
        ? items
        : lines
            .filter((l) => l.account_id.startsWith('acc:exp:') || l.account_id === 'acc:income')
            .map((l, i) => ({
              id: `line-${i}`,
              line_no: i + 1,
              description: l.memo || accountName(l.account_id),
              unit: '',
              qty: 0,
              rate: 0,
              amount: round2(l.debit - l.credit || l.credit - l.debit),
              cost_code: l.cost_code,
              project_id: l.project_id,
              boq_code: l.boq_code || '',
            }));

    return { lines, items, base, vat, tds, retention, advanceRecovered, total, payable, party, project, rows };
  }, [entry]);

  // The sheet registered for Cmd+P is this voucher.
  const printRef = usePrintTarget<HTMLDivElement>({ title: entry ? `Voucher ${entry.id}` : undefined });

  if (!entry || !data) return null;
  const title = TITLES[entry.type] || { en: 'VOUCHER', np: 'भौचर' };
  const isSale = entry.type === 'client-invoice' || entry.type === 'credit-note' || entry.type === 'client-receipt';

  return (
    <Modal isOpen onClose={onClose} size="full" title="Document" description="What prints — taken from the posted entry, not re-typed.">
      <div className="space-y-4">
        <div className="flex justify-end gap-2 no-print">
          <button
            type="button"
            onClick={() => void printSheet(printRef.current, { title: `Voucher ${entry.id}` })}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-gray-900 hover:bg-gray-800 rounded-lg"
            data-testid="print-document"
          >
            <Printer className="w-4 h-4" /> Print / PDF
          </button>
          <button type="button" onClick={onClose} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800">
            <X className="w-4 h-4" /> Close
          </button>
        </div>

        <div ref={printRef} className="bg-white text-gray-900 border border-gray-200 rounded-lg p-8 text-sm" data-testid="doc-sheet">
          {/* Letterhead */}
          <div className="flex items-start justify-between border-b-2 border-gray-800 pb-3">
            <div className="flex items-start gap-3">
              {company.logo && <img src={company.logo} alt="" className="h-12 w-12 object-contain" />}
              <div>
              <h2 className="text-xl font-bold leading-tight">{company.name || 'Your company name'}</h2>
              <p className="text-xs text-gray-600 whitespace-pre-line">{company.address || 'Address not set — add it in Settings'}</p>
              <p className="text-xs text-gray-600">
                {company.phone && <>Tel: {company.phone} · </>}
                {company.email}
              </p>
              <p className="text-xs text-gray-700 mt-1">
                {company.pan ? <>PAN: <span className="font-mono">{company.pan}</span></> : <span className="text-amber-700">PAN not set</span>}
                {company.vatNo && <> · VAT No: <span className="font-mono">{company.vatNo}</span></>}
              </p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-base font-bold tracking-wide">{title.en}</p>
              <p className="text-xs text-gray-600">{title.np}</p>
              <p className="text-xs mt-2">
                No: <span className="font-mono font-semibold">{entry.id}</span>
              </p>
              <p className="text-xs">Date (A.D.): {entry.ad_date}</p>
              <p className="text-xs">
                Date (B.S.): {formatBS({ year: entry.bs_y, month: entry.bs_m, day: entry.bs_d })}
              </p>
              {entry.ref && <p className="text-xs">Bill/Ref: {entry.ref}</p>}
              {entry.mb_ref && <p className="text-xs">MB ref: {entry.mb_ref}</p>}
            </div>
          </div>

          {/* Party */}
          <div className="grid grid-cols-2 gap-4 py-3 border-b border-gray-300 text-xs">
            <div>
              <p className="text-[10px] uppercase tracking-wide text-gray-500">{isSale ? 'Bill to' : 'Supplier'}</p>
              <p className="font-semibold text-sm">{data.party || '—'}</p>
              {entry.party_address && <p className="text-gray-600">{entry.party_address}</p>}
              {entry.party_pan && <p className="text-gray-600">PAN: {entry.party_pan}</p>}
            </div>
            <div className="text-right">
              <p className="text-[10px] uppercase tracking-wide text-gray-500">Job</p>
              <p className="font-semibold">{data.project || (data.rows[0]?.project_id ?? '—') || '—'}</p>
              {entry.due_date && <p className="text-gray-600">Due: {entry.due_date}</p>}
            </div>
          </div>

          {/* Items */}
          <table className="w-full mt-3 text-xs border-collapse">
            <thead>
              <tr className="border-y border-gray-300 bg-gray-50">
                <th className="text-left px-2 py-1.5 w-8">SN</th>
                <th className="text-left px-2 py-1.5">Description</th>
                <th className="text-left px-2 py-1.5 w-16">Unit</th>
                <th className="text-right px-2 py-1.5 w-20">Qty</th>
                <th className="text-right px-2 py-1.5 w-24">Rate</th>
                <th className="text-right px-2 py-1.5 w-28">Amount</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((it, i) => (
                <tr key={it.id} className="border-b border-gray-100">
                  <td className="px-2 py-1.5 text-gray-500">{i + 1}</td>
                  <td className="px-2 py-1.5">
                    {it.description || '—'}
                    {it.boq_code && <span className="text-[10px] text-gray-500 ml-1">({it.boq_code})</span>}
                  </td>
                  <td className="px-2 py-1.5">{it.unit || '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{it.qty ? it.qty : '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{it.rate ? formatCurrency(it.rate) : '—'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(it.amount)}</td>
                </tr>
              ))}
              {data.rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-2 py-4 text-center text-gray-400">
                    No item detail on this entry.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {/* Totals */}
          <div className="flex justify-end mt-3">
            <table className="text-xs w-72">
              <tbody>
                <tr>
                  <td className="px-2 py-1 text-gray-600">{isSale ? 'Subtotal' : 'Subtotal'}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{formatCurrency(data.base)}</td>
                </tr>
                {data.vat > 0 && (
                  <tr>
                    <td className="px-2 py-1 text-gray-600">VAT</td>
                    <td className="px-2 py-1 text-right tabular-nums">{formatCurrency(data.vat)}</td>
                  </tr>
                )}
                <tr className="border-t border-gray-300">
                  <td className="px-2 py-1 font-semibold">Total</td>
                  <td className="px-2 py-1 text-right tabular-nums font-semibold">{formatCurrency(data.total)}</td>
                </tr>
                {data.tds > 0 && (
                  <tr>
                    <td className="px-2 py-1 text-gray-600">Less: TDS withheld</td>
                    <td className="px-2 py-1 text-right tabular-nums">{formatCurrency(data.tds)}</td>
                  </tr>
                )}
                {data.retention > 0 && (
                  <tr>
                    <td className="px-2 py-1 text-gray-600">Less: Retention</td>
                    <td className="px-2 py-1 text-right tabular-nums">{formatCurrency(data.retention)}</td>
                  </tr>
                )}
                {data.advanceRecovered > 0 && (
                  <tr>
                    <td className="px-2 py-1 text-gray-600">Less: Advance recovered</td>
                    <td className="px-2 py-1 text-right tabular-nums">{formatCurrency(data.advanceRecovered)}</td>
                  </tr>
                )}
                <tr className="border-t-2 border-gray-800">
                  <td className="px-2 py-1 font-bold">{isSale ? 'Net receivable' : 'Net payable'}</td>
                  <td className="px-2 py-1 text-right tabular-nums font-bold">{formatCurrency(data.payable)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-[11px] border-t border-gray-200 pt-2">
            <span className="text-gray-500">Amount in words:</span> {amountInWords(data.payable)}
          </p>
          {entry.note && <p className="mt-1 text-[11px] text-gray-600">Note: {entry.note}</p>}

          {/* Signatures */}
          <div className="grid grid-cols-3 gap-6 mt-10 text-[11px] text-center">
            <div>
              <div className="border-t border-gray-400 pt-1">Prepared by</div>
            </div>
            <div>
              <div className="border-t border-gray-400 pt-1">Checked by</div>
            </div>
            <div>
              <div className="border-t border-gray-400 pt-1">For {company.name || 'the firm'} (Authorised signatory)</div>
            </div>
          </div>
          {entry.attachment && (
            <p className="mt-3 text-[10px] text-gray-500">Attached: {entry.attachment.split('/').pop()}</p>
          )}
          {company.footer && <p className="mt-4 text-[10px] text-center text-gray-500">{company.footer}</p>}
        </div>
      </div>
    </Modal>
  );
}

export default DocumentView;
