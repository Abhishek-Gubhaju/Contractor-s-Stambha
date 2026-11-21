// ============================================================================
// Inventory — the material store as a real sub-ledger.
//
//   Items      the master: name, unit, cost code, reorder level
//   Movement   receive (cost in), issue (cost out to a job), adjust (count)
//   On hand    quantity, moving-average cost, value, reorder shortfall
//   Movements  every posting with the entry it created, reversible in place
//
// Cost sits in Materials Inventory until it is issued to a job, so a job is
// charged for what it consumed, not for what the store bought.
// ============================================================================
import { useEffect, useMemo, useState } from 'react';
import { Package, ArrowDownToLine, ArrowUpFromLine, Scale, Trash2, Undo2, Plus } from 'lucide-react';
import { formatCurrency, cn } from '../utils';
import { getTodayBS } from '../utils/nepaliDate';
import { formatBS } from '../utils/nepaliDate';
import { loadCostCodes, loadProjects } from '../services/masterData';
import {
  loadStockItems,
  loadMovements,
  stockOnHand,
  stockOf,
  inventoryReconciliation,
  postStockMovement,
  reverseStockEntry,
  upsertStockItem,
  removeStockItem,
  type StockMoveKind,
} from '../services/stockService';
import { todayAD } from '../services/booksService';
import { destroyDialog } from '../components/ui/DialogHost';

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

const KINDS: { kind: StockMoveKind; label: string; icon: React.ReactNode; desc: string }[] = [
  { kind: 'receipt', label: 'Receive', icon: <ArrowDownToLine className="w-3.5 h-3.5" />, desc: 'Stock in at cost' },
  { kind: 'issue', label: 'Issue', icon: <ArrowUpFromLine className="w-3.5 h-3.5" />, desc: 'Consumed on a job' },
  { kind: 'adjust', label: 'Adjust', icon: <Scale className="w-3.5 h-3.5" />, desc: 'Physical count difference' },
];

export default function InventoryPage() {
  const [tick, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);

  useEffect(() => {
    const changed = () => bump();
    window.addEventListener('contractoros:stock-changed', changed);
    window.addEventListener('contractoros:books-changed', changed);
    return () => {
      window.removeEventListener('contractoros:stock-changed', changed);
      window.removeEventListener('contractoros:books-changed', changed);
    };
  }, []);

  const items = useMemo(() => loadStockItems(), [tick]);
  const onHand = useMemo(() => stockOnHand(), [tick]);
  const recon = useMemo(() => inventoryReconciliation(), [tick]);
  const movements = useMemo(
    () => loadMovements().slice().sort((a, b) => b.ad_date.localeCompare(a.ad_date) || b.created_at.localeCompare(a.created_at)),
    [tick]
  );
  const projects = useMemo(() => loadProjects(), [tick]);
  const costCodes = useMemo(() => loadCostCodes(), [tick]);

  const [move, setMove] = useState({
    kind: 'receipt' as StockMoveKind,
    item_id: '',
    qty: '',
    rate: '',
    date: todayAD(),
    project_id: '',
    cost_code: '',
    boq_code: '',
    supplier: '',
    source: 'cash' as 'cash' | 'supplier',
    method: 'cash',
    vat_rate: '',
    ref: '',
    note: '',
  });
  const [moveError, setMoveError] = useState('');
  const [moveMsg, setMoveMsg] = useState('');

  const [newItem, setNewItem] = useState({ name: '', unit: '', costCode: 'Materials', reorderLevel: '' });
  const [itemError, setItemError] = useState('');

  const [reversing, setReversing] = useState<string | null>(null);
  const [reverseReason, setReverseReason] = useState('');
  const [reverseError, setReverseError] = useState('');

  const set = (key: string, value: any) => setMove((m) => ({ ...m, [key]: value }));
  const selectedItem = items.find((i) => i.id === move.item_id);
  const carrying = move.item_id ? stockOf(move.item_id) : null;

  const post = () => {
    setMoveError('');
    setMoveMsg('');
    try {
      const qty = move.kind === 'adjust' ? Number(move.qty) : Math.abs(Number(move.qty));
      const { entry } = postStockMovement({
        kind: move.kind,
        item_id: move.item_id,
        date: move.date,
        qty,
        rate: Number(move.rate) || undefined,
        project_id: move.project_id,
        cost_code: move.cost_code || selectedItem?.costCode,
        boq_code: move.boq_code,
        supplier: move.supplier,
        method: move.method,
        source: move.kind === 'receipt' ? move.source : undefined,
        vat_rate: Number(move.vat_rate) || 0,
        ref: move.ref,
        note: move.note,
      });
      setMoveMsg(`Posted ${entry.id} — ${entry.type.replace('stock-', 'stock ')}.`);
      setMove((m) => ({ ...m, qty: '', rate: '', ref: '', note: '' }));
      bump();
    } catch (e) {
      setMoveError(e instanceof Error ? e.message : String(e));
    }
  };

  const addItem = () => {
    try {
      upsertStockItem({
        name: newItem.name,
        unit: newItem.unit,
        costCode: newItem.costCode,
        reorderLevel: Number(newItem.reorderLevel) || 0,
      });
      setNewItem({ name: '', unit: '', costCode: 'Materials', reorderLevel: '' });
      setItemError('');
      bump();
    } catch (e) {
      setItemError(e instanceof Error ? e.message : String(e));
    }
  };

  const deleteItem = async (id: string, name: string) => {
    const ok = await destroyDialog({
      title: 'Remove item',
      message: `Remove ${name} from the master? Items with movements cannot be removed.`,
      confirmLabel: 'Remove item',
    });
    if (!ok) return;
    try {
      removeStockItem(id);
      bump();
    } catch (e) {
      setItemError(e instanceof Error ? e.message : String(e));
    }
  };

  const doReverse = () => {
    if (!reversing) return;
    try {
      const rev = reverseStockEntry(reversing, reverseReason);
      setReversing(null);
      setReverseReason('');
      setReverseError('');
      setMoveMsg(`Reversal ${rev.id} posted — the ledger entry and the quantity both moved back.`);
      bump();
    } catch (e) {
      setReverseError(e instanceof Error ? e.message : String(e));
    }
  };

  const todayBs = getTodayBS();

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1>Inventory</h1>
          <p className="text-sm text-gray-500">
            Stock is an asset until issued to a job.
          </p>
          <p className="text-xs text-indigo-600 font-medium mt-1">
            B.S. Today: {formatBS(todayBs)}
          </p>
        </div>
        <div
          className={cn(
            'text-xs rounded-xl border px-3 py-2',
            recon.balanced ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'
          )}
          data-testid="inventory-recon"
        >
          <span className="font-semibold">Inventory control</span>{' '}
          ledger {formatCurrency(recon.ledger)} · store {formatCurrency(recon.store)}
          {recon.balanced ? ' ✓' : ` · off by ${formatCurrency(recon.difference)}`}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Movement form */}
        <div className="bg-white rounded-xl border p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Package className="w-4 h-4 text-gray-500" />
            <h2 className="text-sm font-bold text-gray-900">Post a movement</h2>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {KINDS.map((k) => (
              <button
                key={k.kind}
                type="button"
                data-testid={`move-kind-${k.kind}`}
                onClick={() => set('kind', k.kind)}
                className={cn(
                  'text-left border rounded-lg px-2.5 py-2 transition-colors',
                  move.kind === k.kind ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-blue-300'
                )}
              >
                <p className="text-xs font-semibold text-gray-900 flex items-center gap-1">{k.icon} {k.label}</p>
                <p className="text-[10px] text-gray-500 mt-0.5">{k.desc}</p>
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field id="mv-item" label="Item">
              <select
                id="mv-item"
                className={inputCls}
                value={move.item_id}
                onChange={(e) => set('item_id', e.target.value)}
                aria-label="Item"
              >
                <option value="">Select…</option>
                {items.map((i) => (
                  <option key={i.id} value={i.id}>{i.name}{i.unit ? ` (${i.unit})` : ''}</option>
                ))}
              </select>
            </Field>
            <Field id="mv-date" label="Date (A.D.)">
              <input id="mv-date" type="date" className={inputCls} value={move.date} onChange={(e) => set('date', e.target.value)} />
            </Field>
            <Field
              id="mv-qty"
              label={move.kind === 'adjust' ? 'Count difference (±)' : 'Quantity'}
              hint={carrying ? `On hand ${carrying.qty} · avg ${formatCurrency(carrying.avg)}` : undefined}
            >
              <input id="mv-qty" type="number" step="any" className={inputCls} value={move.qty} onChange={(e) => set('qty', e.target.value)} aria-label="Quantity" />
            </Field>
            <Field
              id="mv-rate"
              label={move.kind === 'receipt' ? 'Unit cost' : 'Unit cost (blank = average)'}
            >
              <input id="mv-rate" type="number" step="any" className={inputCls} value={move.rate} onChange={(e) => set('rate', e.target.value)} aria-label="Unit cost" />
            </Field>
          </div>

          {move.kind === 'receipt' && (
            <div className="grid grid-cols-3 gap-3">
              <Field id="mv-source" label="Paid by">
                <select id="mv-source" className={inputCls} value={move.source} onChange={(e) => set('source', e.target.value)}>
                  <option value="cash">Cash</option>
                  <option value="supplier">On credit (supplier)</option>
                </select>
              </Field>
              {move.source === 'supplier' ? (
                <Field id="mv-supplier" label="Supplier">
                  <input id="mv-supplier" className={inputCls} value={move.supplier} onChange={(e) => set('supplier', e.target.value)} />
                </Field>
              ) : (
                <Field id="mv-method" label="Method">
                  <select id="mv-method" className={inputCls} value={move.method} onChange={(e) => set('method', e.target.value)}>
                    <option value="cash">Cash</option>
                    <option value="bank">Bank</option>
                  </select>
                </Field>
              )}
              <Field id="mv-vat" label="VAT %" hint="0 = no VAT">
                <input id="mv-vat" type="number" step="any" className={inputCls} value={move.vat_rate} onChange={(e) => set('vat_rate', e.target.value)} />
              </Field>
            </div>
          )}

          {move.kind === 'issue' && (
            <div className="grid grid-cols-3 gap-3">
              <Field id="mv-project" label="Job">
                <select id="mv-project" className={inputCls} value={move.project_id} onChange={(e) => set('project_id', e.target.value)} aria-label="Job">
                  <option value="">Select…</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.id} · {p.name}</option>)}
                </select>
              </Field>
              <Field id="mv-cost" label="Cost code">
                <select id="mv-cost" className={inputCls} value={move.cost_code || selectedItem?.costCode || ''} onChange={(e) => set('cost_code', e.target.value)}>
                  {costCodes.map((c) => <option key={c.code} value={c.name}>{c.code} · {c.name}</option>)}
                </select>
              </Field>
              <Field id="mv-boq" label="BOQ item (optional)" hint="Writes back to the item's actuals">
                <input id="mv-boq" className={inputCls} value={move.boq_code} onChange={(e) => set('boq_code', e.target.value)} placeholder="A.01" />
              </Field>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field id="mv-ref" label="Reference"><input id="mv-ref" className={inputCls} value={move.ref} onChange={(e) => set('ref', e.target.value)} placeholder="GRN / MR-12" /></Field>
            <Field id="mv-note" label="Note"><input id="mv-note" className={inputCls} value={move.note} onChange={(e) => set('note', e.target.value)} /></Field>
          </div>

          {moveError && <p className="text-sm text-red-600 border border-gray-200 border-l-2 border-l-red-600 bg-white rounded-lg px-3 py-2" role="alert" data-testid="move-error">{moveError}</p>}
          {moveMsg && <p className="text-sm text-emerald-700 border border-gray-200 border-l-2 border-l-green-600 bg-white rounded-lg px-3 py-2" data-testid="move-message">{moveMsg}</p>}

          <button
            type="button"
            onClick={post}
            className="w-full inline-flex items-center justify-center gap-2 bg-gray-900 hover:bg-gray-800 text-white px-4 py-2 rounded-lg text-sm font-medium"
            data-testid="post-movement"
          >
            <Plus className="w-4 h-4" /> Post movement
          </button>
        </div>

        {/* Item master */}
        <div className="bg-white rounded-xl border p-5 space-y-3">
          <h2 className="text-sm font-bold text-gray-900">Items</h2>
          <div className="grid grid-cols-2 gap-2">
            <input className={inputCls} placeholder="Cement OPC 43" value={newItem.name} onChange={(e) => setNewItem({ ...newItem, name: e.target.value })} aria-label="New item name" />
            <input className={inputCls} placeholder="bag" value={newItem.unit} onChange={(e) => setNewItem({ ...newItem, unit: e.target.value })} aria-label="New item unit" />
            <select className={inputCls} value={newItem.costCode} onChange={(e) => setNewItem({ ...newItem, costCode: e.target.value })} aria-label="New item cost code">
              {costCodes.map((c) => <option key={c.code} value={c.name}>{c.code} · {c.name}</option>)}
            </select>
            <input className={inputCls} type="number" placeholder="Reorder level" value={newItem.reorderLevel} onChange={(e) => setNewItem({ ...newItem, reorderLevel: e.target.value })} aria-label="New item reorder level" />
          </div>
          <button type="button" onClick={addItem} className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded-lg px-3 py-1.5" data-testid="add-item">
            <Plus className="w-4 h-4" /> Add item
          </button>
          {itemError && <p className="text-xs text-red-600" role="alert">{itemError}</p>}

          <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden max-h-64 overflow-y-auto" data-testid="item-list">
            {items.length === 0 && <li className="px-3 py-3 text-xs text-gray-400">No items yet — add one above.</li>}
            {items.map((i) => (
              <li key={i.id} className="flex items-center justify-between px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-medium text-gray-900">{i.name}</span>
                  <span className="ml-2 text-xs text-gray-400">{i.unit} · {i.costCode}</span>
                </span>
                <button onClick={() => deleteItem(i.id, i.name)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded" aria-label={`Remove ${i.name}`}>
                  <Trash2 className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* On hand */}
      <div className="bg-white rounded-xl border">
        <div className="px-5 py-3 border-b border-gray-100">
          <h2 className="text-sm font-bold text-gray-900">Stock on hand</h2>
          <p className="text-xs text-gray-500">Valued at the weighted moving average of everything received.</p>
        </div>
        <table className="w-full text-sm" data-testid="stock-table">
          <thead className="bg-gray-50 text-xs uppercase text-gray-500">
            <tr>
              <th className="text-left px-5 py-2">Item</th>
              <th className="text-right px-5 py-2">Qty</th>
              <th className="text-right px-5 py-2">Avg cost</th>
              <th className="text-right px-5 py-2">Value</th>
              <th className="text-left px-5 py-2">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {onHand.length === 0 && (
              <tr><td colSpan={5} className="px-5 py-6 text-center text-xs text-gray-400">Nothing in the store yet.</td></tr>
            )}
            {onHand.map((r) => (
              <tr key={r.item.id}>
                <td className="px-5 py-2">
                  <span className="font-medium text-gray-900">{r.item.name}</span>
                  <span className="ml-2 text-xs text-gray-400">{r.item.unit}</span>
                </td>
                <td className="px-5 py-2 text-right tabular-nums">{r.qty}</td>
                <td className="px-5 py-2 text-right tabular-nums">{formatCurrency(r.avg)}</td>
                <td className="px-5 py-2 text-right tabular-nums">{formatCurrency(r.value)}</td>
                <td className="px-5 py-2">
                  {r.shortfall > 0 ? (
                    <span className="text-[11px] text-amber-700 bg-white border border-gray-200 border-l-2 border-l-amber-600 rounded px-1.5 py-0.5">
                      reorder {r.shortfall}
                    </span>
                  ) : (
                    <span className="text-[11px] text-gray-400">ok</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Movements */}
      <div className="bg-white rounded-xl border">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-gray-900">Movements</h2>
            <p className="text-xs text-gray-500">Every movement posts to the ledger; reversing restores the quantity.</p>
          </div>
          <span className="text-xs text-gray-400">{movements.length} total</span>
        </div>

        {reversing && (
          <div className="px-5 py-3 bg-rose-50 border-b border-rose-200 space-y-2">
            <p className="text-xs font-semibold text-rose-800">Reverse {reversing}</p>
            <div className="flex gap-2">
              <input
                className="flex-1 border border-rose-200 rounded-lg px-3 py-1.5 text-sm"
                placeholder="Reason (required)"
                value={reverseReason}
                onChange={(e) => setReverseReason(e.target.value)}
                aria-label="Reversal reason"
              />
              <button className="px-3 py-1.5 text-sm font-medium text-white bg-rose-600 hover:bg-rose-700 rounded-lg" onClick={doReverse} data-testid="stock-reverse-confirm">
                Reverse
              </button>
              <button className="px-3 py-1.5 text-sm text-gray-600" onClick={() => { setReversing(null); setReverseError(''); }}>
                Cancel
              </button>
            </div>
            {reverseError && <p className="text-xs text-red-700" role="alert">{reverseError}</p>}
          </div>
        )}

        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500 sticky top-0">
              <tr>
                <th className="text-left px-5 py-2">Date</th>
                <th className="text-left px-5 py-2">Entry</th>
                <th className="text-left px-5 py-2">Item</th>
                <th className="text-left px-5 py-2">Kind</th>
                <th className="text-right px-5 py-2">Qty</th>
                <th className="text-right px-5 py-2">Rate</th>
                <th className="text-right px-5 py-2">Value</th>
                <th className="px-5 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {movements.length === 0 && (
                <tr><td colSpan={8} className="px-5 py-6 text-center text-xs text-gray-400">No stock has moved yet.</td></tr>
              )}
              {movements.map((m) => {
                const item = items.find((i) => i.id === m.item_id);
                return (
                  <tr key={m.id}>
                    <td className="px-5 py-2 text-gray-600">{m.ad_date}</td>
                    <td className="px-5 py-2 font-mono text-xs text-gray-500">{m.entry_id}</td>
                    <td className="px-5 py-2">{item?.name || m.item_id}</td>
                    <td className="px-5 py-2">
                      <span className={cn(
                        'text-[11px] border rounded px-1.5 py-0.5',
                        m.qty >= 0 ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-rose-50 text-rose-700 border-rose-200'
                      )}>
                        {m.kind}
                      </span>
                    </td>
                    <td className="px-5 py-2 text-right tabular-nums">{m.qty}</td>
                    <td className="px-5 py-2 text-right tabular-nums">{formatCurrency(m.rate)}</td>
                    <td className="px-5 py-2 text-right tabular-nums">{formatCurrency(Math.abs(m.qty) * m.rate)}</td>
                    <td className="px-5 py-2 text-right">
                      <button
                        className="p-1.5 text-gray-400 hover:text-rose-600 hover:bg-rose-50 rounded"
                        aria-label={`Reverse ${m.entry_id}`}
                        onClick={() => { setReversing(m.entry_id); setReverseReason(''); setReverseError(''); }}
                      >
                        <Undo2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
