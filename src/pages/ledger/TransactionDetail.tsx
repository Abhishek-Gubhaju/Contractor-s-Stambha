// ============================================================================
// TransactionDetail — the read-only “i” view of one ledger entry.
//
// ONE shared component so every ledger list (statements now, feed/daybook/
// parties later) opens the same, complete picture: header facts, amounts and
// tax, the general-ledger lines behind it, linked entries (bill ↔ payment,
// reversal ↔ original) and the attached documents with preview/download.
//
// Strictly read-only: nothing here posts, edits or removes anything.
// ============================================================================
import { useMemo, useState } from 'react';
import { Download, ExternalLink, FileText, Paperclip, X } from 'lucide-react';
import { Modal } from '../../components/ui';
import { formatCurrency } from '../../utils';
import { formatBS } from '../../utils/nepaliDate';
import { allEntries, accountName, entryById, linesOf, loadBillLinks, type Entry } from '../../services/booksService';
import { documentsForEntry } from '../../services/attachmentService';
import { formatBytes } from '../../services/staffService';
import { TYPE_LABEL } from './Feed';

export interface TransactionDetailProps {
  entryId: string | null;
  onClose: () => void;
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-gray-500">{label}</p>
      <p className="text-sm text-gray-800 break-words">{value || '—'}</p>
    </div>
  );
}

function bsLabel(entry: Entry): string {
  if (!entry.bs_y) return '';
  try {
    return formatBS({ year: entry.bs_y, month: entry.bs_m, day: entry.bs_d });
  } catch {
    return '';
  }
}

export function TransactionDetail({ entryId, onClose }: TransactionDetailProps) {
  const entry = entryId ? entryById(entryId) || null : null;
  const lines = useMemo(() => (entry ? linesOf(entry.id) : []), [entry?.id]);
  const documents = useMemo(() => documentsForEntry(entry), [entry?.id, entry?.attachment]);
  const [preview, setPreview] = useState<{ name: string; mimeType: string; dataUrl: string } | null>(null);

  if (!entry) {
    return (
      <Modal isOpen={Boolean(entryId)} onClose={onClose} size="lg" title="Transaction details">
        <p className="text-sm text-gray-500" data-testid="detail-not-found">
          This entry could not be found. It may belong to another job or an older backup.
        </p>
      </Modal>
    );
  }

  const debit = round2(lines.reduce((s, l) => s + l.debit, 0));
  const credit = round2(lines.reduce((s, l) => s + l.credit, 0));
  const partyLine = lines.find((l) => l.party_id) || lines.find((l) => l.worker_id);
  const party = partyLine ? partyLine.party_id || accountName(partyLine.account_id) : '';
  const categories = [...new Set(lines.map((l) => l.cost_code).filter(Boolean))].join(', ');
  const projects = [...new Set(lines.map((l) => l.project_id).filter(Boolean))].join(', ');
  const vat = round2(
    lines.filter((l) => l.account_id === 'acc:vat-input').reduce((s, l) => s + l.debit, 0) +
      lines.filter((l) => l.account_id === 'acc:vat-output').reduce((s, l) => s + l.credit, 0)
  );
  const tds = round2(lines.filter((l) => l.account_id === 'acc:tds-payable').reduce((s, l) => s + l.credit, 0));
  const cashLine = lines.find((l) => ['acc:cash', 'acc:bank'].includes(l.account_id));
  const method = cashLine ? (cashLine.account_id === 'acc:bank' ? 'Bank' : 'Cash') : '';

  const billLinks = loadBillLinks();
  const linked: { label: string; id: string; amount?: number }[] = [];
  const addLink = (label: string, id: string, amount?: number) => {
    if (!id || linked.some((l) => l.label === label && l.id === id)) return;
    linked.push({ label, id, amount });
  };
  if (entry.auto_payment_id) addLink('Paid with', entry.auto_payment_id);
  if (entry.auto_bill_id) addLink('Payment for bill', entry.auto_bill_id);
  if (entry.reversal_of) addLink('Reverses', entry.reversal_of);
  const reversal = allEntries().find((e) => e.reversal_of === entry.id);
  if (reversal) addLink('Reversed by', reversal.id);
  for (const link of billLinks.filter((l) => l.bill_line_id.startsWith(`${entry.id}#`))) {
    addLink('Settled by', link.payment_line_id.split('#')[0], link.applied_amount);
  }
  for (const link of billLinks.filter((l) => l.payment_line_id.startsWith(`${entry.id}#`))) {
    addLink('Settles bill', link.bill_line_id.split('#')[0], link.applied_amount);
  }

  return (
    <Modal
      isOpen={Boolean(entryId)}
      onClose={onClose}
      size="lg"
      title={`${TYPE_LABEL(entry.type)} — ${entry.id}`}
      description={`${bsLabel(entry) || 'B.S. unavailable'} · A.D. ${entry.ad_date}`}
    >
      <div className="space-y-5" data-testid="transaction-detail">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <Field label="Entry no." value={entry.id} />
          <Field label="Date (B.S.)" value={bsLabel(entry)} />
          <Field label="Date (A.D.)" value={entry.ad_date} />
          <Field label="Type" value={TYPE_LABEL(entry.type)} />
          <Field label="Source" value={entry.source} />
          <Field label="Party" value={party} />
          <Field label="Category / cost code" value={categories} />
          <Field label="Project / job" value={projects} />
          <Field label="Method" value={method} />
          <Field label="Debit" value={formatCurrency(debit)} />
          <Field label="Credit" value={formatCurrency(credit)} />
          <Field label="VAT" value={vat ? formatCurrency(vat) : ''} />
          <Field label="TDS withheld" value={tds ? formatCurrency(tds) : ''} />
          <Field label="Reference" value={entry.ref} />
          <Field label="Note" value={entry.note} />
          {entry.due_date ? <Field label="Due date" value={entry.due_date} /> : null}
          {entry.mb_ref ? <Field label="MB / measurement ref" value={entry.mb_ref} /> : null}
          {entry.party_pan ? <Field label="Party PAN" value={entry.party_pan} /> : null}
        </div>

        <div>
          <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1.5">General ledger lines</p>
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <table className="w-full text-xs" data-testid="detail-lines">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="text-left px-3 py-1.5">Account</th>
                  <th className="text-left px-3 py-1.5">Party / worker</th>
                  <th className="text-left px-3 py-1.5">Project</th>
                  <th className="text-left px-3 py-1.5">Memo</th>
                  <th className="text-right px-3 py-1.5">Debit</th>
                  <th className="text-right px-3 py-1.5">Credit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {lines.map((l) => (
                  <tr key={l.id}>
                    <td className="px-3 py-1.5">{accountName(l.account_id)}</td>
                    <td className="px-3 py-1.5">{l.party_id || (l.worker_id ? accountName(l.account_id) : '—')}</td>
                    <td className="px-3 py-1.5">{l.project_id || '—'}</td>
                    <td className="px-3 py-1.5 text-gray-500">{l.memo || '—'}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{l.debit ? formatCurrency(l.debit) : ''}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{l.credit ? formatCurrency(l.credit) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1.5">Linked entries</p>
          {linked.length === 0 ? (
            <p className="text-xs text-gray-400" data-testid="detail-no-links">No linked entries.</p>
          ) : (
            <ul className="space-y-1" data-testid="detail-links">
              {linked.map((l, i) => (
                <li key={`${l.label}-${l.id}-${i}`} className="flex items-center justify-between text-xs border border-gray-200 rounded-lg px-3 py-1.5">
                  <span className="text-gray-600">
                    {l.label} <span className="font-mono text-gray-800">{l.id}</span>
                  </span>
                  {typeof l.amount === 'number' && <span className="tabular-nums text-gray-700">{formatCurrency(l.amount)}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div data-testid="detail-documents">
          <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1.5">
            Documents {documents.length > 0 ? `(${documents.length})` : ''}
          </p>
          {documents.length === 0 ? (
            <p className="text-xs text-gray-400" data-testid="detail-no-documents">No documents attached.</p>
          ) : (
            <ul className="divide-y border border-gray-200 rounded-lg">
              {documents.map((doc) => (
                <li key={doc.path} className="flex items-center justify-between gap-2 px-3 py-2" data-testid="detail-document">
                  <span className="flex items-center gap-2 min-w-0">
                    <Paperclip className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                    <span className="min-w-0">
                      <span className="block text-xs font-medium truncate">{doc.fileName}</span>
                      <span className="block text-[11px] text-gray-400">
                        {doc.mimeType || 'unknown type'}
                        {doc.sizeBytes ? ` · ${formatBytes(doc.sizeBytes)}` : ''}
                        {doc.checksum ? ` · ${doc.checksum}` : ''}
                        {doc.available ? '' : ' · file missing'}
                      </span>
                    </span>
                  </span>
                  <span className="flex items-center gap-1 shrink-0">
                    {doc.available ? (
                      <>
                        <button
                          type="button"
                          onClick={() => setPreview({ name: doc.fileName, mimeType: doc.mimeType, dataUrl: doc.dataUrl })}
                          className="text-[11px] px-2 py-1 rounded border hover:bg-gray-50"
                          data-testid="detail-document-view"
                        >
                          View
                        </button>
                        <button
                          type="button"
                          onClick={() => window.open(doc.dataUrl, '_blank')}
                          className="text-[11px] px-2 py-1 rounded border hover:bg-gray-50 inline-flex items-center gap-1"
                          title="Open in the default viewer"
                        >
                          <ExternalLink className="w-3 h-3" /> Open
                        </button>
                        <a
                          href={doc.dataUrl}
                          download={doc.fileName}
                          className="text-[11px] px-2 py-1 rounded border hover:bg-gray-50 inline-flex items-center gap-1"
                        >
                          <Download className="w-3 h-3" /> Download
                        </a>
                      </>
                    ) : (
                      <span className="text-[11px] text-amber-700 inline-flex items-center gap-1"><FileText className="w-3 h-3" /> not stored</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {preview && (
            <div className="mt-2 border border-gray-200 rounded-lg overflow-hidden" data-testid="detail-preview">
              <div className="flex items-center justify-between px-2 py-1.5 bg-gray-50 border-b border-gray-100">
                <p className="text-xs font-medium truncate">{preview.name}</p>
                <button type="button" onClick={() => setPreview(null)} aria-label="Close preview" className="p-1 rounded hover:bg-gray-100">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              {preview.mimeType.startsWith('image/') ? (
                <img src={preview.dataUrl} alt={preview.name} className="max-h-72 mx-auto object-contain p-2" />
              ) : preview.mimeType === 'application/pdf' ? (
                <iframe title={preview.name} src={preview.dataUrl} className="w-full h-72 border-0" />
              ) : (
                <p className="p-3 text-xs text-gray-500">This file can't be previewed here — use Open or Download.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

export default TransactionDetail;
