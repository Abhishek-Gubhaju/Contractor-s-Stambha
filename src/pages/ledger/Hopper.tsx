// ============================================================================
// Hopper — THE single entry point for the books (S2.1, S3).
//
//   • Type card grid; selecting a type swaps the adaptive fieldset (S3.1/3.2)
//   • Shared fields always visible: date (AD picker + local-calendar preview),
//     reference, note, attachment
//   • Routing preview calls THE SAME pure recipe(type, form) as save —
//     preview == truth (S2.3 / acceptance 72)
//   • Save = atomic insert of entry + lines; toast summarizes routing (S3.4)
//   • Edit = regenerate lines atomically, previous version in edited_history;
//     auto-entries jump to their source instead (S3.5 / S5.3)
//   • Labour expense categories are blocked with a pointer to Labour (S0.3)
// ============================================================================
import { useMemo, useState } from 'react';
import {
  FileText, Banknote, Download, Upload, Receipt, ArrowLeftRight, Landmark,
  Scale, UserRound, Link2, AlertCircle,
} from 'lucide-react';
import { Modal } from '../../components/ui';
import { formatCurrency, cn } from '../../utils';
import { formatBS } from '../../utils/nepaliDate';
import {
  type EntryType,
  type Entry,
  type DraftLine,
  recipe,
  saveEntry,
  saveSupplierBill,
  attachDocumentToEntry,
  supplierBillPayable,
  supplierBillPaymentForm,
  editEntry,
  entryById,
  accountName,
  accountsForAdjustment,
  EXPENSE_CATEGORIES,
  isLabourCategory,
  safeBs,
  parties,
  billedToDate,
  clientAdvanceBalance,
} from '../../services/booksService';
import { loadWorkers, postAdvance, workerLabel } from '../../services/labourService';
import { defaultVatRate } from '../../services/taxService';
import { loadBoqItems, loadCostCodes, loadProjects } from '../../services/masterData';
import { documentTotals, amountInWords, blankItem, type DocItem } from '../../services/documentService';
import { ensureParty, partyByName, partiesOfType } from '../../services/partyService';
import { ItemsEditor } from './ItemsEditor';
import { validateAttachment } from '../../services/attachmentService';
import { formatBytes } from '../../services/staffService';
import { getTodayBS } from '../../utils/nepaliDate';

export const HOPPER_TYPES: { type: EntryType; label: string; desc: string }[] = [
  { type: 'supplier-bill', label: 'Supplier Bill', desc: 'Accrue a purchase against a supplier' },
  { type: 'payment-supplier', label: 'Payment to Supplier', desc: 'Pay open bills, apply withholding' },
  { type: 'client-receipt', label: 'Client Receipt', desc: 'Money in — apply invoices + retention' },
  { type: 'client-invoice', label: 'Client Invoice', desc: 'Raise a bill to a client + retention' },
  { type: 'client-advance', label: 'Client Advance', desc: 'Mobilisation money received before a bill' },
  { type: 'opening-balance', label: 'Opening Balance', desc: 'Start the books with cash, bank or party balances' },
  { type: 'purchase-return', label: 'Purchase Return', desc: 'Debit note — send goods back, reverse VAT' },
  { type: 'credit-note', label: 'Credit Note', desc: 'Reduce a client bill already issued' },
  { type: 'expense-paid', label: 'Expense Paid Now', desc: 'Category expense paid from cash/bank' },
  { type: 'worker-advance', label: 'Worker Advance', desc: 'Cash advance to a worker' },
  { type: 'transfer', label: 'Cash ↔ Bank', desc: 'Move money between cash and bank' },
  { type: 'owner-loan-in', label: 'Owner / Loan In', desc: 'Capital or loan brought in' },
  { type: 'adjustment', label: 'Adjustment Journal', desc: 'Dr one account · Cr another' },
];

const inputCls =
  'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500';
const labelCls = 'block text-xs font-medium text-gray-600 mb-1';

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className={labelCls}>{label}</label>
      {children}
      {hint && <p className="text-[11px] text-gray-400 mt-0.5">{hint}</p>}
    </div>
  );
}

function kathmanduToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

const METHODS = ['cash', 'bank', 'cheque'];
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export interface HopperProps {
  isOpen: boolean;
  onClose: () => void;
  initialType?: EntryType | null;
  initialForm?: Record<string, any> | null;
  editingId?: string | null;
  onSaved?: (entry: Entry, summary: string) => void;
  onNavigate?: (page: string) => void;
}

export function Hopper({ isOpen, onClose, initialType, initialForm, editingId, onSaved, onNavigate }: HopperProps) {
  const [type, setType] = useState<EntryType | null>(initialType ?? null);
  const [form, setForm] = useState<Record<string, any>>(initialForm ?? {});
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const [pendingFile, setPendingFile] = useState<{ fileName: string; mimeType: string; dataUrl: string; sizeBytes: number } | null>(null);
  const [removeAttachment, setRemoveAttachment] = useState(false);

  // Re-sync when the hopper is (re)opened, e.g. edit or a fresh capture.
  const [lastOpen, setLastOpen] = useState(false);
  if (isOpen !== lastOpen) {
    setLastOpen(isOpen);
    if (isOpen) {
      setType(initialType ?? null);
      setForm(initialForm ?? {});
      setError('');
      setReason('');
      setPendingFile(null);
      setRemoveAttachment(false);
    }
  }

  const today = kathmanduToday();
  const set = (key: string, value: any) => setForm((f) => ({ ...f, [key]: value }));

  // Typing a party that exists in the master fills the printed identity (PAN,
  // address) and that party's credit days — typed once, reused everywhere.
  const applyParty = (kind: 'client' | 'supplier', name: string) =>
    setForm((f) => {
      const party = partyByName(name);
      if (!party) return { ...f, [kind]: name };
      return {
        ...f,
        [kind]: name,
        party_pan: f.party_pan || party.pan,
        party_address: f.party_address || party.address,
        ...(kind === 'supplier' && !Number(f.due_days) && party.creditDays > 0 ? { due_days: party.creditDays } : {}),
      };
    });

  // Item lines (supplier bill, running bill, debit / credit note). The totals
  // below are computed by THE document engine the posting recipe uses, so the
  // figure on screen is the figure that posts.
  const items = (form.items || []) as DocItem[];
  const totals = useMemo(
    () =>
      items.length
        ? documentTotals(items, {
            vatRate: Number(form.vat_rate) || 0,
            vatIncluded: Boolean(form.vat_included),
            tdsRate: Number(form.tds_rate) || 0,
            retentionPct: Number(form.retention_pct) || 0,
            discount: Number(form.discount) || 0,
            roundOff: Number(form.round_off) || 0,
          })
        : null,
    [form.items, form.vat_rate, form.vat_included, form.tds_rate, form.retention_pct, form.discount, form.round_off]
  );

  const workers = useMemo(() => (type === 'worker-advance' ? loadWorkers() : []), [type, isOpen]);
  // Masters drive the pickers so a posting can never invent a second job or
  // an unknown cost code.
  const projects = useMemo(() => loadProjects(), [type, isOpen]);
  const costCodes = useMemo(() => loadCostCodes().filter((c) => !isLabourCategory(c.name)), [type, isOpen]);
  const boqItems = useMemo(
    () =>
      type === 'supplier-bill' ||
      type === 'expense-paid' ||
      type === 'purchase-return' ||
      type === 'client-invoice' ||
      type === 'credit-note'
        ? loadBoqItems()
        : [],
    [type, isOpen]
  );
  const todayBs = getTodayBS();
  const openPartyRows = useMemo(
    () => (type === 'payment-supplier' || type === 'client-receipt' ? parties({ year: todayBs.year, month: todayBs.month }) : []),
    [type, isOpen]
  );

  // Live routing preview — THE SAME recipe the save action runs (S2.3).
  const preview = useMemo<{ drafts: DraftLine[] | null; error: string }>(() => {
    if (!type) return { drafts: null, error: '' };
    try {
      return { drafts: recipe(type, { date: form.date || today, ...form }), error: '' };
    } catch (e) {
      return { drafts: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [type, form, today]);

  // “Paid now”: the bill's own Payment to Supplier entry. The preview always
  // shows both legs, priced by the same recipes the save action runs, and the
  // supplier due left after the pair (zero when it is paid in full).
  const currentAttachment = editingId ? entryById(editingId)?.attachment || '' : '';
  const paidNow = type === 'supplier-bill' && Boolean(form.paid_now) && !editingId;
  const tdsHeld = (Number(form.tds_rate) || 0) > 0;
  const billPayable = type === 'supplier-bill' && preview.drafts ? supplierBillPayable(preview.drafts) : 0;
  const paymentPreview = useMemo<{ drafts: DraftLine[] | null; error: string }>(() => {
    if (!paidNow || tdsHeld || !(billPayable > 0)) return { drafts: null, error: '' };
    try {
      return {
        drafts: recipe('payment-supplier', supplierBillPaymentForm({ ...form, date: form.date || today }, billPayable, 'new')),
        error: '',
      };
    } catch (e) {
      return { drafts: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [paidNow, tdsHeld, billPayable, form, today]);

  // Documents that attract VAT start at the company's configured rate; TDS
  // starts at zero because it applies to services/rent, not every purchase.
  const taxDefaults = (t: EntryType): Record<string, any> =>
    t === 'supplier-bill' || t === 'client-invoice' ? { vat_rate: defaultVatRate() } : {};

  const ITEM_TYPES: EntryType[] = ['supplier-bill', 'client-invoice', 'purchase-return', 'credit-note'];

  const selectType = (t: EntryType) => {
    setType(t);
    setError('');
    setForm({
      date: form.date || today,
      ref: form.ref || '',
      note: form.note || '',
      ...(ITEM_TYPES.includes(t) ? { items: [] } : {}),
      ...taxDefaults(t),
    });
  };

  const summaryOf = (drafts: DraftLine[]): string =>
    drafts
      .map((l) => `${l.debit > 0 ? 'Dr' : 'Cr'} ${accountName(l.account_id)} ${formatCurrency(l.debit > 0 ? l.debit : l.credit)}`)
      .join(' · ');

  const save = () => {
    setError('');
    if (!type) return;
    try {
      if (editingId) {
        const drafts = recipe(type, form);
        const entry = editEntry(editingId, type, form, reason, {
          ...(pendingFile ? { attachment_file: pendingFile } : {}),
          ...(removeAttachment ? { remove_attachment: true } : {}),
        });
        onSaved?.(entry, `Entry ${entry.id} updated: ${summaryOf(drafts)}`);
        onClose();
        return;
      }
      if (type === 'worker-advance') {
        // Advances settle worker statements too — route through the labour
        // recorder (S5.1: advances via hopper type only, one posting path).
        const { voucher } = postAdvance({
          worker_id: String(form.worker_id),
          date: String(form.date || today),
          amount: Number(form.amount),
          method: form.method === 'bank' ? 'bank' : 'cash',
          ref: String(form.ref || ''),
          note: String(form.note || ''),
        });
        // The labour recorder owns the posting, so the document is attached to
        // the entry it created (stored + linked together, rolled back on error).
        if (pendingFile) attachDocumentToEntry(voucher, pendingFile);
        const entry = entryById(voucher)!;
        onSaved?.(entry, `Entry ${entry.id}: ${summaryOf(recipe(type, form))}`);
        onClose();
        return;
      }
      // The file travels with the save: entry + document + link are one atomic
      // write, so a rejected entry never leaves a stored file behind.
      const attachmentOpts = pendingFile ? { attachment_file: pendingFile } : {};
      const drafts = recipe(type, form);
      if (type === 'supplier-bill') {
        // One action; when “Paid now” is ticked it posts the bill AND its
        // Payment to Supplier atomically (both or neither).
        const { bill, payment } = saveSupplierBill(form, attachmentOpts);
        onSaved?.(bill, payment ? `Bill ${bill.id} + payment ${payment.id}: ${summaryOf(drafts)}` : `Entry ${bill.id}: ${summaryOf(drafts)}`);
        onClose();
        return;
      }
      const entry = saveEntry(type, form, attachmentOpts);
      onSaved?.(entry, `Entry ${entry.id}: ${summaryOf(drafts)}`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const pickFile = (file: File | null) => {
    setError('');
    if (!file) return setPendingFile(null);
    const reader = new FileReader();
    reader.onerror = () => setError('That file could not be read — choose it again.');
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      try {
        // Same validation the store applies, so the message appears immediately.
        const checked = validateAttachment({ fileName: file.name, mimeType: file.type, dataUrl, sizeBytes: file.size });
        setPendingFile({ fileName: checked.fileName, mimeType: checked.mimeType, dataUrl, sizeBytes: checked.sizeBytes });
        setRemoveAttachment(false);
      } catch (e) {
        setPendingFile(null);
        setError(e instanceof Error ? e.message : String(e));
      }
    };
    reader.readAsDataURL(file);
  };

  // ---- shared fields (always visible, S3.1) -------------------------------
  const shared = (
    <div className="grid grid-cols-2 gap-3">
      <Field id="hop-date" label="Date (A.D.)" hint={safeBs(form.date || today).year ? `B.S. ${formatBS(safeBs(form.date || today))}` : undefined}>
        <input
          id="hop-date"
          type="date"
          className={inputCls}
          value={form.date || today}
          onChange={(e) => {
            const d = e.target.value;
            // The payment date follows the bill date until the user moves it.
            setForm((f) => ({ ...f, date: d, ...(f.paid_now && (!f.pay_date || f.pay_date === (f.date || today)) ? { pay_date: d } : {}) }));
          }}
        />
      </Field>
      <Field id="hop-ref" label="Reference">
        <input id="hop-ref" className={inputCls} value={form.ref || ''} onChange={(e) => set('ref', e.target.value)} placeholder="e.g. INV-45, PO-12" />
      </Field>
      <div className="col-span-2">
        <Field id="hop-note" label="Note">
          <input id="hop-note" className={inputCls} value={form.note || ''} onChange={(e) => set('note', e.target.value)} placeholder="Optional note" />
        </Field>
      </div>
      <div className="col-span-2">
        <Field
          id="hop-attachment"
          label="Attachment"
          hint={
            pendingFile
              ? `${pendingFile.fileName} · ${formatBytes(pendingFile.sizeBytes)} — stored with the entry`
              : editingId && currentAttachment
                ? `Current: ${currentAttachment.split('/').pop()}`
                : 'Image (PNG, JPG, WEBP, GIF) or PDF, up to 5 MB'
          }
        >
          <input
            id="hop-attachment"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"
            className={inputCls}
            onChange={(e) => pickFile(e.target.files?.[0] || null)}
          />
        </Field>
        {pendingFile && (
          <button type="button" onClick={() => setPendingFile(null)} className="text-[11px] text-rose-600 hover:underline mt-1">
            Discard the selected file
          </button>
        )}
        {editingId && !pendingFile && currentAttachment && (
          <label className="flex items-center gap-2 text-[11px] text-gray-600 mt-1">
            <input
              type="checkbox"
              data-testid="remove-attachment"
              checked={removeAttachment}
              onChange={(e) => setRemoveAttachment(e.target.checked)}
            />
            Remove the current document
          </label>
        )}
      </div>
    </div>
  );

  // ---- adaptive fieldsets (S3.2) -----------------------------------------
  const fields = () => {
    switch (type) {
      case 'supplier-bill':
        return (
          <div className="grid grid-cols-2 gap-3">
            <Field id="hop-supplier" label="Supplier">
              <input id="hop-supplier" className={inputCls} list="hop-suppliers" value={form.supplier || ''} onChange={(e) => applyParty('supplier', e.target.value)} placeholder="Bill from" />
              <datalist id="hop-suppliers">{partiesOfType('supplier').map((p) => <option key={p.id} value={p.name} />)}</datalist>
            </Field>
            <Field id="hop-project" label="Project">
              <input id="hop-project" className={inputCls} list="hop-projects" value={form.project || ''} onChange={(e) => set('project', e.target.value)} placeholder="PRJ-001" />
              <datalist id="hop-projects">{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</datalist>
            </Field>
            <Field id="hop-cost" label="Cost category" hint="Cost code from the master">
              <select id="hop-cost" className={inputCls} value={form.cost_code || ''} onChange={(e) => set('cost_code', e.target.value)}>
                <option value="">Select…</option>
                {costCodes.map((c) => <option key={c.code} value={c.name}>{c.code} · {c.name}</option>)}
              </select>
            </Field>
            <Field id="hop-boq" label="BOQ item (optional)" hint="Books this cost against the item's actuals">
              <input id="hop-boq" className={inputCls} list="hop-boq-items" value={form.boq_code || ''} onChange={(e) => set('boq_code', e.target.value)} placeholder="A.01" />
              <datalist id="hop-boq-items">{boqItems.map((b) => <option key={b.itemCode} value={b.itemCode}>{b.description}</option>)}</datalist>
            </Field>
            <Field id="hop-due" label="Due days"><input id="hop-due" type="number" className={inputCls} value={form.due_days || ''} onChange={(e) => set('due_days', e.target.value)} /></Field>
            <Field id="hop-party-pan" label="Supplier bill no. / PAN"><input id="hop-party-pan" className={inputCls} value={form.party_pan || ''} onChange={(e) => set('party_pan', e.target.value)} placeholder="PAN number" /></Field>
            <Field id="hop-discount" label="Discount (optional)" hint="Spread over the lines before VAT">
              <input id="hop-discount" type="number" step="any" className={inputCls} value={form.discount || ''} onChange={(e) => set('discount', e.target.value)} />
            </Field>
            <Field id="hop-round" label="Round off (optional)" hint="+/− to the payable, posted to Round-off">
              <input id="hop-round" type="number" step="any" className={inputCls} value={form.round_off || ''} onChange={(e) => set('round_off', e.target.value)} />
            </Field>
            <div className="col-span-2">
              <ItemsEditor
                items={items}
                onChange={(next) => set('items', next)}
                costCodes={costCodes}
                projects={projects}
                boqItems={boqItems}
                defaultCostCode={form.cost_code || ''}
                defaultProject={form.project || ''}
                label="Bill items"
              />
            </div>
            <div className="col-span-2 grid grid-cols-3 gap-2">
              <Field id="hop-vat" label="VAT %" hint="0 = no VAT">
                <input id="hop-vat" type="number" step="any" className={inputCls} value={form.vat_rate ?? ''} onChange={(e) => set('vat_rate', e.target.value)} />
              </Field>
              <Field id="hop-tds" label="TDS %" hint="On the pre-VAT value">
                <input
                  id="hop-tds"
                  type="number"
                  step="any"
                  className={inputCls}
                  value={form.tds_rate ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    // TDS is withheld when the payment is made — this bill is
                    // settled from Payment to Supplier instead.
                    setForm((f) => ({ ...f, tds_rate: v, ...(Number(v) > 0 ? { paid_now: false } : {}) }));
                  }}
                />
              </Field>
              <label className="flex items-end gap-2 pb-2 text-xs text-gray-600">
                <input type="checkbox" data-testid="vat-included" checked={Boolean(form.vat_included)} onChange={(e) => set('vat_included', e.target.checked)} />
                Amount includes VAT
              </label>
            </div>
            <div className="col-span-2 border border-gray-200 rounded-lg px-3 py-2" data-testid="paid-now-block">
              <label
                className="flex items-center gap-2 text-xs font-medium text-gray-700"
                title={tdsHeld ? 'TDS is withheld on payment.' : undefined}
              >
                <input
                  type="checkbox"
                  data-testid="paid-now"
                  checked={Boolean(form.paid_now)}
                  disabled={tdsHeld || Boolean(editingId)}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setForm((f) => ({
                      ...f,
                      paid_now: on,
                      ...(on ? { pay_method: f.pay_method || 'cash', pay_date: f.pay_date || f.date || today } : {}),
                    }));
                  }}
                />
                Paid now — post the payment with this bill
              </label>
              {tdsHeld && (
                <p className="text-[11px] text-amber-700 mt-1" data-testid="paid-now-tds-hint">
                  TDS is withheld on payment — settle the bill from Payment to Supplier.
                </p>
              )}
              {paidNow && !tdsHeld && (
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <Field id="hop-pay-method" label="Paid from">
                    <select id="hop-pay-method" className={inputCls} value={form.pay_method || 'cash'} onChange={(e) => set('pay_method', e.target.value)}>
                      <option value="cash">Cash</option>
                      <option value="bank">Bank</option>
                    </select>
                  </Field>
                  <Field id="hop-pay-date" label="Payment date">
                    <input id="hop-pay-date" type="date" className={inputCls} value={form.pay_date || form.date || today} onChange={(e) => set('pay_date', e.target.value)} />
                  </Field>
                </div>
              )}
            </div>
          </div>
        );
      case 'payment-supplier': {
        const row = openPartyRows.find((r) => r.party_id === (form.supplier || ''));
        const due = row?.openBills.filter((b) => b.kind === 'bill') || [];
        const dueTotal = due.reduce((s, b) => s + b.outstanding, 0);
        const allocations = (form.allocations || []) as { entry_id: string; applied: number }[];
        const toggle = (id: string, outstanding: number) => {
          const has = allocations.some((a) => a.entry_id === id);
          set('allocations', has ? allocations.filter((a) => a.entry_id !== id) : [...allocations, { entry_id: id, applied: outstanding }]);
        };
        const setApplied = (id: string, value: number) => {
          const has = allocations.some((a) => a.entry_id === id);
          const next = has
            ? allocations.map((a) => (a.entry_id === id ? { ...a, applied: value } : a))
            : [...allocations, { entry_id: id, applied: value }];
          set('allocations', next);
        };
        const appliedTotal = round2(allocations.reduce((s, a) => s + (Number(a.applied) || 0), 0));
        const available = round2((Number(form.amount) || 0) - (Number(form.withholding) || 0));
        const unallocated = round2(available - appliedTotal);
        const autoAllocate = () => {
          let left = available;
          const next: { entry_id: string; applied: number }[] = [];
          for (const b of due) {
            if (left <= 0) break;
            const applied = round2(Math.min(left, b.outstanding));
            next.push({ entry_id: b.id, applied });
            left = round2(left - applied);
          }
          set('allocations', next);
        };
        return (
          <div className="grid grid-cols-3 gap-3">
            <Field id="hop-supplier" label="Supplier">
              <input id="hop-supplier" className={inputCls} list="hop-suppliers" value={form.supplier || ''} onChange={(e) => { applyParty('supplier', e.target.value); set('allocations', []); }} placeholder="Paid to" />
              <datalist id="hop-suppliers">{partiesOfType('supplier').map((p) => <option key={p.id} value={p.name} />)}</datalist>
            </Field>
            <Field id="hop-amount" label="Amount"><input id="hop-amount" type="number" step="any" className={inputCls} value={form.amount || ''} onChange={(e) => set('amount', e.target.value)} /></Field>
            <Field id="hop-method" label="Method">
              <select id="hop-method" className={inputCls} value={form.method || 'cash'} onChange={(e) => set('method', e.target.value)}>
                {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </Field>
            <Field id="hop-withholding" label="Withholding (optional)"><input id="hop-withholding" type="number" step="any" className={inputCls} value={form.withholding || ''} onChange={(e) => set('withholding', e.target.value)} /></Field>
            <div className="col-span-2">
              <div className="flex items-center justify-between">
                <p className={labelCls}>Open bills — amount due {formatCurrency(dueTotal)}</p>
                <button type="button" onClick={autoAllocate} className="text-[11px] text-blue-700 hover:underline" data-testid="auto-allocate">Allocate oldest first</button>
              </div>
              <div className="border border-gray-200 rounded-lg max-h-48 overflow-y-auto divide-y divide-gray-100" data-testid="open-bills">
                {due.length === 0 && <p className="text-xs text-gray-400 px-3 py-2">No open bills for this supplier.</p>}
                {due.map((b) => {
                  const row = allocations.find((a) => a.entry_id === b.id);
                  return (
                    <div key={b.id} className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs">
                      <span className="flex items-center gap-2 min-w-0">
                        <input type="checkbox" checked={Boolean(row)} onChange={() => toggle(b.id, b.outstanding)} />
                        <span className="truncate">{b.id} · due {b.due}</span>
                      </span>
                      <span className="flex items-center gap-2 shrink-0">
                        <span className="text-gray-400">{formatCurrency(b.outstanding)}</span>
                        <input
                          type="number"
                          step="any"
                          className="w-24 border border-gray-200 rounded px-2 py-0.5 text-right tabular-nums"
                          value={row ? row.applied : ''}
                          placeholder="0"
                          aria-label={`Allocate to ${b.id}`}
                          onChange={(e) => setApplied(b.id, Number(e.target.value) || 0)}
                        />
                      </span>
                    </div>
                  );
                })}
              </div>
              <p className="text-[11px] text-gray-500 mt-1" data-testid="unallocated">
                Allocated {formatCurrency(appliedTotal)} · unallocated {formatCurrency(Math.max(0, unallocated))}
                {unallocated > 0.005 && ' → kept as advance to the supplier'}
              </p>
            </div>
          </div>
        );
      }
      case 'client-receipt': {
        const row = openPartyRows.find((r) => r.party_id === (form.client || ''));
        const inv = row?.openBills.filter((b) => b.kind === 'invoice') || [];
        const dueTotal = inv.reduce((s, b) => s + b.outstanding, 0);
        const allocations = (form.allocations || []) as { entry_id: string; applied: number }[];
        const toggle = (id: string, outstanding: number) => {
          const has = allocations.some((a) => a.entry_id === id);
          set('allocations', has ? allocations.filter((a) => a.entry_id !== id) : [...allocations, { entry_id: id, applied: outstanding }]);
        };
        return (
          <div className="grid grid-cols-3 gap-3">
            <Field id="hop-client" label="Client"><input id="hop-client" className={inputCls} value={form.client || ''} onChange={(e) => { set('client', e.target.value); set('allocations', []); }} /></Field>
            <Field id="hop-amount" label="Amount"><input id="hop-amount" type="number" step="any" className={inputCls} value={form.amount || ''} onChange={(e) => set('amount', e.target.value)} /></Field>
            <Field id="hop-method" label="Method">
              <select id="hop-method" className={inputCls} value={form.method || 'cash'} onChange={(e) => set('method', e.target.value)}>
                {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </Field>
            <Field id="hop-retention" label="Retention released"><input id="hop-retention" type="number" step="any" className={inputCls} value={form.retention_release || ''} onChange={(e) => set('retention_release', e.target.value)} /></Field>
            <div className="col-span-2">
              <div className="flex items-center justify-between">
                <p className={labelCls}>Open invoices — due {formatCurrency(dueTotal)}</p>
                <button
                  type="button"
                  className="text-[11px] text-blue-700 hover:underline"
                  data-testid="auto-allocate-invoices"
                  onClick={() => {
                    let left = round2((Number(form.amount) || 0) - (Number(form.retention_release) || 0));
                    const next: { entry_id: string; applied: number }[] = [];
                    for (const b of inv) {
                      if (left <= 0) break;
                      const applied = round2(Math.min(left, b.outstanding));
                      next.push({ entry_id: b.id, applied });
                      left = round2(left - applied);
                    }
                    set('allocations', next);
                  }}
                >
                  Allocate oldest first
                </button>
              </div>
              <div className="border border-gray-200 rounded-lg max-h-48 overflow-y-auto divide-y divide-gray-100" data-testid="open-invoices">
                {inv.length === 0 && <p className="text-xs text-gray-400 px-3 py-2">No open invoices for this client.</p>}
                {inv.map((b) => {
                  const row = allocations.find((a) => a.entry_id === b.id);
                  return (
                    <div key={b.id} className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs">
                      <span className="flex items-center gap-2 min-w-0">
                        <input type="checkbox" checked={Boolean(row)} onChange={() => toggle(b.id, b.outstanding)} />
                        <span className="truncate">{b.id} · due {b.due}</span>
                      </span>
                      <span className="flex items-center gap-2 shrink-0">
                        <span className="text-gray-400">{formatCurrency(b.outstanding)}</span>
                        <input
                          type="number"
                          step="any"
                          className="w-24 border border-gray-200 rounded px-2 py-0.5 text-right tabular-nums"
                          value={row ? row.applied : ''}
                          placeholder="0"
                          aria-label={`Allocate to ${b.id}`}
                          onChange={(e) => {
                            const value = Number(e.target.value) || 0;
                            set(
                              'allocations',
                              allocations.some((a) => a.entry_id === b.id)
                                ? allocations.map((a) => (a.entry_id === b.id ? { ...a, applied: value } : a))
                                : [...allocations, { entry_id: b.id, applied: value }]
                            );
                          }}
                        />
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        );
      }
      case 'client-invoice':
        return (
          <div className="grid grid-cols-3 gap-3">
            <Field id="hop-client" label="Client">
              <input id="hop-client" className={inputCls} list="hop-clients" value={form.client || ''} onChange={(e) => applyParty('client', e.target.value)} placeholder="Bill to" />
              <datalist id="hop-clients">{partiesOfType('client').map((p) => <option key={p.id} value={p.name} />)}</datalist>
            </Field>
            <Field id="hop-project" label="Project">
              <input id="hop-project" className={inputCls} list="hop-projects" value={form.project || ''} onChange={(e) => set('project', e.target.value)} placeholder="PRJ-001" />
              <datalist id="hop-projects">{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</datalist>
            </Field>
            <Field id="hop-retention-pct" label="Retention %"><input id="hop-retention-pct" type="number" step="any" className={inputCls} value={form.retention_pct ?? ''} onChange={(e) => set('retention_pct', e.target.value)} /></Field>
            <Field id="hop-vat" label="VAT %" hint="0 = no VAT">
              <input id="hop-vat" type="number" step="any" className={inputCls} value={form.vat_rate ?? ''} onChange={(e) => set('vat_rate', e.target.value)} />
            </Field>
            <Field id="hop-party-pan" label="Client PAN"><input id="hop-party-pan" className={inputCls} value={form.party_pan || ''} onChange={(e) => set('party_pan', e.target.value)} placeholder="PAN number" /></Field>
            <Field id="hop-party-address" label="Client address"><input id="hop-party-address" className={inputCls} value={form.party_address || ''} onChange={(e) => set('party_address', e.target.value)} placeholder="City" /></Field>
            <Field id="hop-discount" label="Discount (optional)" hint="Spread over the lines before VAT">
              <input id="hop-discount" type="number" step="any" className={inputCls} value={form.discount || ''} onChange={(e) => set('discount', e.target.value)} />
            </Field>
            <Field id="hop-round" label="Round off (optional)" hint="+/− to the receivable">
              <input id="hop-round" type="number" step="any" className={inputCls} value={form.round_off || ''} onChange={(e) => set('round_off', e.target.value)} />
            </Field>
            <Field id="hop-advance" label={`Advance recovery (held ${formatCurrency(clientAdvanceBalance(form.client || ''))})`} hint="Recovered from this bill, not paid again">
              <input id="hop-advance" type="number" step="any" className={inputCls} value={form.advance_recovery || ''} onChange={(e) => set('advance_recovery', e.target.value)} />
            </Field>
            <Field id="hop-mb" label="MB / measurement ref" hint="Printed on the bill">
              <input id="hop-mb" className={inputCls} value={form.mb_ref || ''} onChange={(e) => set('mb_ref', e.target.value)} placeholder="MB-12 / page 4" />
            </Field>
            <div className="col-span-3 border border-gray-200 rounded-lg px-3 py-2 bg-gray-50 text-xs grid grid-cols-3 gap-2" data-testid="running-bill-summary">
              <span>Billed to date<br /><b className="tabular-nums">{formatCurrency(billedToDate(form.project || ''))}</b></span>
              <span>This bill (taxable)<br /><b className="tabular-nums">{formatCurrency(totals?.base || 0)}</b></span>
              <span>Cumulative<br /><b className="tabular-nums">{formatCurrency(billedToDate(form.project || '') + (totals?.base || 0))}</b></span>
            </div>
            <div className="col-span-3">
              <div className="flex items-center justify-between mb-1">
                <span />
                <button
                  type="button"
                  className="text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded px-2 py-1"
                  data-testid="load-boq-items"
                  onClick={() => {
                    const rows = loadBoqItems(form.project || '')
                      .filter((b) => (b.rate || 0) > 0)
                      .map((b) =>
                        blankItem({
                          description: b.description,
                          unit: b.unit,
                          qty: 0,
                          rate: b.rate || 0,
                          project_id: form.project || '',
                          boq_code: b.itemCode,
                        })
                      );
                    if (rows.length) set('items', rows);
                  }}
                >
                  Load {form.project || 'job'} BOQ items
                </button>
              </div>
              <ItemsEditor
                items={items}
                onChange={(next) => set('items', next)}
                costCodes={costCodes}
                projects={projects}
                boqItems={boqItems}
                defaultProject={form.project || ''}
                showCostCode={false}
                label="Bill lines (BOQ items)"
              />
            </div>
          </div>
        );
      case 'purchase-return':
        return (
          <div className="grid grid-cols-3 gap-3">
            <Field id="hop-supplier" label="Supplier">
              <input id="hop-supplier" className={inputCls} list="hop-suppliers" value={form.supplier || ''} onChange={(e) => applyParty('supplier', e.target.value)} placeholder="Bill from" />
              <datalist id="hop-suppliers">{partiesOfType('supplier').map((p) => <option key={p.id} value={p.name} />)}</datalist>
            </Field>
            <Field id="hop-project" label="Project">
              <input id="hop-project" className={inputCls} list="hop-projects" value={form.project || ''} onChange={(e) => set('project', e.target.value)} placeholder="PRJ-001" />
              <datalist id="hop-projects">{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</datalist>
            </Field>
            <Field id="hop-vat" label="VAT %" hint="Credit the VAT you claimed">
              <input id="hop-vat" type="number" step="any" className={inputCls} value={form.vat_rate ?? ''} onChange={(e) => set('vat_rate', e.target.value)} />
            </Field>
            <Field id="hop-party-pan" label="Supplier PAN"><input id="hop-party-pan" className={inputCls} value={form.party_pan || ''} onChange={(e) => set('party_pan', e.target.value)} placeholder="PAN number" /></Field>
            <div className="col-span-3">
              <ItemsEditor
                items={items}
                onChange={(next) => set('items', next)}
                costCodes={costCodes}
                projects={projects}
                boqItems={boqItems}
                defaultProject={form.project || ''}
                label="Returned items"
              />
            </div>
          </div>
        );
      case 'credit-note':
        return (
          <div className="grid grid-cols-3 gap-3">
            <Field id="hop-client" label="Client"><input id="hop-client" className={inputCls} value={form.client || ''} onChange={(e) => set('client', e.target.value)} /></Field>
            <Field id="hop-project" label="Project">
              <input id="hop-project" className={inputCls} list="hop-projects" value={form.project || ''} onChange={(e) => set('project', e.target.value)} placeholder="PRJ-001" />
              <datalist id="hop-projects">{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</datalist>
            </Field>
            <Field id="hop-vat" label="VAT %" hint="Reverse the VAT on the credit">
              <input id="hop-vat" type="number" step="any" className={inputCls} value={form.vat_rate ?? ''} onChange={(e) => set('vat_rate', e.target.value)} />
            </Field>
            <div className="col-span-3">
              <ItemsEditor
                items={items}
                onChange={(next) => set('items', next)}
                costCodes={costCodes}
                projects={projects}
                boqItems={boqItems}
                defaultProject={form.project || ''}
                showCostCode={false}
                label="Credited lines"
              />
            </div>
          </div>
        );
      case 'client-advance':
        return (
          <div className="grid grid-cols-3 gap-3">
            <Field id="hop-client" label="Client">
              <input id="hop-client" className={inputCls} list="hop-clients" value={form.client || ''} onChange={(e) => applyParty('client', e.target.value)} placeholder="Received from" />
              <datalist id="hop-clients">{partiesOfType('client').map((p) => <option key={p.id} value={p.name} />)}</datalist>
            </Field>
            <Field id="hop-project" label="Project (optional)">
              <input id="hop-project" className={inputCls} list="hop-projects" value={form.project || ''} onChange={(e) => set('project', e.target.value)} placeholder="PRJ-001" />
              <datalist id="hop-projects">{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</datalist>
            </Field>
            <Field id="hop-amount" label="Advance amount"><input id="hop-amount" type="number" step="any" className={inputCls} value={form.amount || ''} onChange={(e) => set('amount', e.target.value)} /></Field>
            <Field id="hop-method" label="Received into">
              <select id="hop-method" className={inputCls} value={form.method || 'bank'} onChange={(e) => set('method', e.target.value)}>
                {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </Field>
            <Field id="hop-party-pan" label="Client PAN"><input id="hop-party-pan" className={inputCls} value={form.party_pan || ''} onChange={(e) => set('party_pan', e.target.value)} /></Field>
          </div>
        );
      case 'opening-balance': {
        const target = String(form.account || 'cash');
        const needsParty = target === 'receivable' || target === 'payable';
        return (
          <div className="grid grid-cols-3 gap-3">
            <Field id="hop-ob-account" label="Opening">
              <select id="hop-ob-account" className={inputCls} value={target} onChange={(e) => set('account', e.target.value)}>
                <option value="cash">Cash in hand</option>
                <option value="bank">Bank balance</option>
                <option value="receivable">Client owes us</option>
                <option value="payable">We owe a supplier</option>
              </select>
            </Field>
            {needsParty && (
              <Field id="hop-ob-party" label={target === 'receivable' ? 'Client' : 'Supplier'}>
                <input id="hop-ob-party" className={inputCls} list="hop-ob-parties" value={form.party || ''} onChange={(e) => set('party', e.target.value)} />
                <datalist id="hop-ob-parties">
                  {partiesOfType(target === 'receivable' ? 'client' : 'supplier').map((p) => <option key={p.id} value={p.name} />)}
                </datalist>
              </Field>
            )}
            <Field id="hop-amount" label="Amount"><input id="hop-amount" type="number" step="any" className={inputCls} value={form.amount || ''} onChange={(e) => set('amount', e.target.value)} /></Field>
            {needsParty && (
              <Field id="hop-ob-project" label="Project (optional)">
                <input id="hop-ob-project" className={inputCls} list="hop-projects" value={form.project || ''} onChange={(e) => set('project', e.target.value)} />
                <datalist id="hop-projects">{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</datalist>
              </Field>
            )}
            <p className="col-span-3 text-[11px] text-gray-500">
              Opening entries offset Opening Balance (equity), keeping the trial balance green.
            </p>
          </div>
        );
      }
      case 'expense-paid':
        return (
          <div className="grid grid-cols-2 gap-3">
            <Field id="hop-category" label="Category" hint="Labour & salary lines are owned by payroll — use the Labour page instead.">
              <select id="hop-category" className={inputCls} value={form.category || ''} onChange={(e) => set('category', e.target.value)}>
                <option value="">Select…</option>
                {costCodes.map((c) => <option key={c.code} value={c.name}>{c.code} · {c.name}</option>)}
              </select>
            </Field>
            <Field id="hop-project" label="Project (optional → overhead)">
              <input id="hop-project" className={inputCls} list="hop-projects" value={form.project || ''} onChange={(e) => set('project', e.target.value)} placeholder="overhead" />
              <datalist id="hop-projects">{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</datalist>
            </Field>
            <Field id="hop-boq" label="BOQ item (optional)" hint="Books this cost against the item's actuals">
              <input id="hop-boq" className={inputCls} list="hop-boq-items" value={form.boq_code || ''} onChange={(e) => set('boq_code', e.target.value)} placeholder="A.01" />
              <datalist id="hop-boq-items">{boqItems.map((b) => <option key={b.itemCode} value={b.itemCode}>{b.description}</option>)}</datalist>
            </Field>
            <Field id="hop-amount" label="Amount"><input id="hop-amount" type="number" step="any" className={inputCls} value={form.amount || ''} onChange={(e) => set('amount', e.target.value)} /></Field>
            <Field id="hop-method" label="Method">
              <select id="hop-method" className={inputCls} value={form.method || 'cash'} onChange={(e) => set('method', e.target.value)}>
                {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </Field>
            {isLabourCategory(form.category || '') && (
              <p className="col-span-2 text-xs text-red-600 flex items-center gap-1" data-testid="labour-block">
                <AlertCircle className="w-3.5 h-3.5" /> Labour expense is owned by payroll — open the Labour page instead.
              </p>
            )}
          </div>
        );
      case 'worker-advance':
        return (
          <div className="grid grid-cols-3 gap-3">
            <Field id="hop-worker" label="Worker">
              <select id="hop-worker" className={inputCls} value={form.worker_id || ''} onChange={(e) => { set('worker_id', e.target.value); set('worker_name', workers.find((w) => w.id === e.target.value)?.name || e.target.value); }}>
                <option value="">Select…</option>
                {workers.map((w) => <option key={w.id} value={w.id}>{workerLabel(w, workers)}</option>)}
              </select>
            </Field>
            <Field id="hop-amount" label="Amount"><input id="hop-amount" type="number" step="any" className={inputCls} value={form.amount || ''} onChange={(e) => set('amount', e.target.value)} /></Field>
            <Field id="hop-method" label="Method">
              <select id="hop-method" className={inputCls} value={form.method || 'cash'} onChange={(e) => set('method', e.target.value)}>
                {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </Field>
          </div>
        );
      case 'transfer':
        return (
          <div className="grid grid-cols-3 gap-3">
            <Field id="hop-from" label="From">
              <select id="hop-from" className={inputCls} value={form.from || 'cash'} onChange={(e) => set('from', e.target.value)}>
                <option value="cash">Cash</option><option value="bank">Bank</option>
              </select>
            </Field>
            <Field id="hop-to" label="To">
              <select id="hop-to" className={inputCls} value={form.to || 'bank'} onChange={(e) => set('to', e.target.value)}>
                <option value="cash">Cash</option><option value="bank">Bank</option>
              </select>
            </Field>
            <Field id="hop-amount" label="Amount"><input id="hop-amount" type="number" step="any" className={inputCls} value={form.amount || ''} onChange={(e) => set('amount', e.target.value)} /></Field>
          </div>
        );
      case 'owner-loan-in':
        return (
          <div className="grid grid-cols-3 gap-3">
            <Field id="hop-source" label="Source">
              <select id="hop-source" className={inputCls} value={form.source || 'owner'} onChange={(e) => set('source', e.target.value)}>
                <option value="owner">Owner capital</option><option value="loan">Loan</option>
              </select>
            </Field>
            <Field id="hop-amount" label="Amount"><input id="hop-amount" type="number" step="any" className={inputCls} value={form.amount || ''} onChange={(e) => set('amount', e.target.value)} /></Field>
            <Field id="hop-method" label="Method">
              <select id="hop-method" className={inputCls} value={form.method || 'bank'} onChange={(e) => set('method', e.target.value)}>
                {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </Field>
          </div>
        );
      case 'adjustment':
        return (
          <div className="grid grid-cols-2 gap-3">
            <Field id="hop-dr" label="Debit account">
              <select id="hop-dr" className={inputCls} value={form.debit_account || ''} onChange={(e) => set('debit_account', e.target.value)}>
                <option value="">Select…</option>
                {accountsForAdjustment().map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
            <Field id="hop-cr" label="Credit account">
              <select id="hop-cr" className={inputCls} value={form.credit_account || ''} onChange={(e) => set('credit_account', e.target.value)}>
                <option value="">Select…</option>
                {accountsForAdjustment().map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
            <Field id="hop-amount" label="Amount"><input id="hop-amount" type="number" step="any" className={inputCls} value={form.amount || ''} onChange={(e) => set('amount', e.target.value)} /></Field>
          </div>
        );
      default:
        return null;
    }
  };

  // ---- type card grid (S3.1) ---------------------------------------------
  const grid = (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3" data-testid="type-grid">
      {HOPPER_TYPES.map((t) => (
        <button
          key={t.type}
          type="button"
          data-testid={`type-${t.type}`}
          onClick={() => selectType(t.type)}
          className="text-left border border-gray-200 rounded-xl p-3 hover:border-blue-400 hover:bg-blue-50 transition-colors"
        >
          <p className="text-sm font-semibold text-gray-900">{t.label}</p>
          <p className="text-xs text-gray-500 mt-0.5">{t.desc}</p>
        </button>
      ))}
      <button
        type="button"
        data-testid="settle-payroll"
        onClick={() => { onNavigate?.('attendance'); onClose(); }}
        className="text-left border border-dashed border-indigo-300 bg-indigo-50 rounded-xl p-3 hover:border-indigo-500 transition-colors"
      >
        <p className="text-sm font-semibold text-indigo-700 flex items-center gap-1"><Link2 className="w-3.5 h-3.5" /> Settle payroll</p>
        <p className="text-xs text-indigo-500 mt-0.5">Opens the Labour payroll run — no form here</p>
      </button>
    </div>
  );

  const meta = HOPPER_TYPES.find((t) => t.type === type);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="full"
      title={editingId ? 'Edit Entry' : 'New Entry'}
      description={meta ? meta.label : 'Choose an entry type — every book posts from the same double-entry recipe.'}
    >
      {!type && grid}
      {type && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 rounded-full px-3 py-1">
                <Receipt className="w-3.5 h-3.5" /> {meta?.label}
              </span>
              <button type="button" className="text-xs text-gray-500 hover:text-gray-700 underline" onClick={() => { setType(null); setError(''); }}>
                change type
              </button>
            </div>
          </div>

          {/* The item table needs the width: stack the routing preview under
              the form until the window is genuinely wide. */}
          <div className="grid grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_22rem] gap-5">
            <div className="space-y-4">
              <div className="border border-gray-200 rounded-xl p-4 space-y-3">
                <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Details</p>
                {fields()}
              </div>
              <div className="border border-gray-200 rounded-xl p-4 space-y-3">
                <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Shared</p>
                {shared}
              </div>
              {editingId && (
                <div className="border border-gray-200 border-l-2 border-l-amber-600 bg-white rounded-xl p-4">
                  <label htmlFor="hop-reason" className={labelCls}>Edit reason (recorded in audit)</label>
                  <input id="hop-reason" className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this entry changing?" />
                </div>
              )}
              {error && (
                <p className="text-sm text-red-600 border border-gray-200 border-l-2 border-l-red-600 bg-white rounded-lg px-3 py-2" data-testid="hopper-error" role="alert">
                  {error}
                </p>
              )}
            </div>

            {/* Routing preview (S3.3) — live on every input */}
            <div className="border border-gray-200 rounded-xl p-4 bg-gray-50 h-fit" data-testid="routing-preview">
              <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-2">Routing preview</p>
              {!preview.drafts && (
                <p className="text-xs text-gray-500" data-testid="routing-hint">{preview.error || 'Fill the form to see routing…'}</p>
              )}
              {preview.drafts && totals && (
                <div className="mb-3 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs space-y-0.5" data-testid="doc-totals">
                  <div className="flex justify-between"><span className="text-gray-500">Subtotal</span><span className="tabular-nums">{formatCurrency(totals.subtotal)}</span></div>
                  {totals.discount > 0 && (
                    <div className="flex justify-between"><span className="text-gray-500">Discount</span><span className="tabular-nums">−{formatCurrency(totals.discount)}</span></div>
                  )}
                  <div className="flex justify-between"><span className="text-gray-500">Taxable value</span><span className="tabular-nums">{formatCurrency(totals.base)}</span></div>
                  {totals.vat > 0 && (
                    <div className="flex justify-between"><span className="text-gray-500">VAT</span><span className="tabular-nums">{formatCurrency(totals.vat)}</span></div>
                  )}
                  {totals.tds > 0 && (
                    <div className="flex justify-between"><span className="text-gray-500">TDS withheld</span><span className="tabular-nums">−{formatCurrency(totals.tds)}</span></div>
                  )}
                  {totals.retention > 0 && (
                    <div className="flex justify-between"><span className="text-gray-500">Retention</span><span className="tabular-nums">−{formatCurrency(totals.retention)}</span></div>
                  )}
                  <div className="flex justify-between border-t border-gray-100 pt-1 font-semibold"><span>Payable</span><span className="tabular-nums">{formatCurrency(totals.payable)}</span></div>
                  <p className="text-[10px] text-gray-400 leading-snug pt-1">{amountInWords(totals.payable)}</p>
                </div>
              )}
              {preview.drafts && (
                <>
                  <ul className="space-y-1.5">
                    {preview.drafts.map((l, i) => (
                      <li key={i} className="flex items-center justify-between text-sm bg-white border border-gray-200 rounded-lg px-3 py-1.5">
                        <span className="text-gray-800">
                          <span className={cn('font-semibold mr-2', l.debit > 0 ? 'text-emerald-600' : 'text-rose-600')}>{l.debit > 0 ? 'Dr' : 'Cr'}</span>
                          {accountName(l.account_id)}
                          {l.party_id && <span className="text-gray-400"> · {l.party_id}</span>}
                          {l.project_id && <span className="text-gray-400"> · {l.project_id}</span>}
                        </span>
                        <span className="font-medium tabular-nums">{formatCurrency(l.debit > 0 ? l.debit : l.credit)}</span>
                      </li>
                    ))}
                  </ul>
                  {type === 'supplier-bill' && (
                    <p className="mt-2 text-xs text-gray-500" data-testid="supplier-due">
                      Supplier due after save:{' '}
                      <b className="tabular-nums text-gray-800">{formatCurrency(paidNow ? 0 : billPayable)}</b>
                    </p>
                  )}
                  {paidNow && (
                    <div className="mt-3 rounded-lg border border-dashed border-blue-300 bg-blue-50 p-2" data-testid="paid-now-preview">
                      <p className="text-[11px] font-semibold text-blue-800 mb-1">
                        Paid now — second entry: Payment to Supplier · {form.pay_method || 'cash'} · {form.pay_date || form.date || today}
                      </p>
                      {paymentPreview.drafts ? (
                        <ul className="space-y-1">
                          {paymentPreview.drafts.map((l, i) => (
                            <li key={i} className="flex items-center justify-between text-xs text-gray-800">
                              <span>
                                <span className={cn('font-semibold mr-2', l.debit > 0 ? 'text-emerald-600' : 'text-rose-600')}>{l.debit > 0 ? 'Dr' : 'Cr'}</span>
                                {accountName(l.account_id)}
                                {l.party_id && <span className="text-gray-400"> · {l.party_id}</span>}
                              </span>
                              <span className="tabular-nums">{formatCurrency(l.debit > 0 ? l.debit : l.credit)}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-[11px] text-gray-500" data-testid="paid-now-preview-hint">
                          {paymentPreview.error || (tdsHeld ? 'TDS bills are settled from Payment to Supplier.' : 'Add a bill amount to see the payment.')}
                        </p>
                      )}
                    </div>
                  )}
                  <div className="flex items-center justify-between mt-3 text-xs">
                    <span className="text-gray-500">Σ Dr {formatCurrency(preview.drafts.reduce((s, l) => s + l.debit, 0))} · Σ Cr {formatCurrency(preview.drafts.reduce((s, l) => s + l.credit, 0))}</span>
                    <span className="font-medium text-emerald-600">balanced</span>
                  </div>
                  <pre className="hidden" data-testid="routing-json">{JSON.stringify(preview.drafts.map((l) => ({ a: l.account_id, d: l.debit, c: l.credit, p: l.party_id || '', w: l.worker_id || '', j: l.project_id || '' })))}</pre>
                </>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2 border-t border-gray-100">
            <button type="button" className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800" onClick={onClose}>Cancel</button>
            <button
              type="button"
              data-testid="save-entry"
              className="px-5 py-2 text-sm font-medium text-white bg-gray-900 hover:bg-gray-800 rounded-lg disabled:opacity-50"
              disabled={!preview.drafts || (paidNow && !paymentPreview.drafts)}
              onClick={save}
            >
              {editingId ? 'Update entry' : 'Save entry'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// keep tree-shaken icon imports referenced (grid glyphs reserved for future)
void FileText; void Banknote; void Download; void Upload; void ArrowLeftRight; void Landmark; void Scale; void UserRound;

export default Hopper;
