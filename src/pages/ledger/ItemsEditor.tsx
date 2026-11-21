// ============================================================================
// ItemsEditor — the item table of a supplier bill, running bill, debit note or
// credit note.
//
// This is what a contractor actually holds in hand: a paper bill with many
// rows. Each row keeps its own qty, unit, rate, cost code, job and BOQ item, so
// a single bill can split cement to one job and rods to another without being
// re-typed as two documents.
//
// Amount = qty × rate unless the user types an amount directly (a lump-sum
// transport charge has no qty). Totals are shown by Hopper, from the same
// documentTotals() the posting engine uses.
// ============================================================================
import { Plus, Trash2, Copy } from 'lucide-react';
import { formatCurrency } from '../../utils';
import { blankItem, type DocItem } from '../../services/documentService';

export interface ItemsEditorProps {
  items: DocItem[];
  onChange: (items: DocItem[]) => void;
  costCodes: { code: string; name: string }[];
  projects: { id: string; name: string }[];
  boqItems: { itemCode: string; description: string }[];
  /** Applied to new rows only; existing rows keep their own values. */
  defaultCostCode?: string;
  defaultProject?: string;
  /** Client invoices do not book a cost code; only qty/rate/description. */
  showCostCode?: boolean;
  showBoq?: boolean;
  label?: string;
}

const cell =
  'w-full border border-gray-200 rounded px-2 py-1 text-xs bg-white focus:ring-1 focus:ring-blue-500 focus:border-blue-500';

export function ItemsEditor({
  items,
  onChange,
  costCodes,
  projects,
  boqItems,
  defaultCostCode = '',
  defaultProject = '',
  showCostCode = true,
  showBoq = true,
  label = 'Items',
}: ItemsEditorProps) {
  const update = (id: string, patch: Partial<DocItem>) => {
    onChange(
      items.map((it) => {
        if (it.id !== id) return it;
        const next = { ...it, ...patch };
        // Recompute the line total whenever qty/rate move and no hand-typed
        // amount is pinned to the row.
        if ('qty' in patch || 'rate' in patch) {
          next.amount = Math.round((Number(next.qty) || 0) * (Number(next.rate) || 0) * 100) / 100;
        }
        return next;
      })
    );
  };

  const add = () =>
    onChange([
      ...items,
      blankItem({ cost_code: defaultCostCode, project_id: defaultProject }),
    ]);

  const duplicate = (it: DocItem) =>
    onChange([
      ...items,
      { ...it, id: blankItem().id, line_no: items.length + 1 },
    ]);

  const remove = (id: string) => onChange(items.filter((it) => it.id !== id));

  const total = items.reduce((s, it) => s + (Number(it.amount) || 0), 0);
  // # · description · unit · qty · rate · amount · job · actions, plus the
  // optional cost-code and BOQ columns. (The old count forgot the action cell,
  // so the empty state and the totals row spanned two columns too few.)
  const cols = 8 + (showCostCode ? 1 : 0) + (showBoq ? 1 : 0);

  return (
    <div className="space-y-2" data-testid="items-editor">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide">{label}</p>
        <button
          type="button"
          onClick={add}
          className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded px-2 py-1"
          data-testid="add-item"
        >
          <Plus className="w-3.5 h-3.5" /> Add line
        </button>
      </div>

      <div className="overflow-x-auto border border-gray-200 rounded-lg">
        <table className="w-full min-w-[820px] text-xs">
          <thead className="bg-gray-50 text-gray-500">
            <tr>
              <th className="px-2 py-1.5 text-left w-7">#</th>
              <th className="px-2 py-1.5 text-left min-w-[200px]">Description</th>
              <th className="px-2 py-1.5 text-left w-16">Unit</th>
              <th className="px-2 py-1.5 text-right w-20">Qty</th>
              <th className="px-2 py-1.5 text-right w-24">Rate</th>
              <th className="px-2 py-1.5 text-right w-24">Amount</th>
              {showCostCode && <th className="px-2 py-1.5 text-left w-32">Cost code</th>}
              <th className="px-2 py-1.5 text-left w-24">Job</th>
              {showBoq && <th className="px-2 py-1.5 text-left w-20">BOQ</th>}
              <th className="px-2 py-1.5 w-14"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {items.length === 0 && (
              <tr>
                <td colSpan={cols} className="px-3 py-4 text-center text-gray-400">
                  No lines yet — add the first item on the bill.
                </td>
              </tr>
            )}
            {items.map((it, i) => (
              <tr key={it.id} className="align-top">
                <td className="px-2 py-1.5 text-gray-400">{i + 1}</td>
                <td className="px-2 py-1.5">
                  <input
                    className={cell}
                    value={it.description}
                    onChange={(e) => update(it.id, { description: e.target.value })}
                    placeholder="Cement OPC 43 grade"
                    aria-label={`Item ${i + 1} description`}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    className={cell}
                    value={it.unit}
                    onChange={(e) => update(it.id, { unit: e.target.value })}
                    placeholder="bag"
                    aria-label={`Item ${i + 1} unit`}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    type="number"
                    step="any"
                    className={`${cell} text-right tabular-nums`}
                    value={it.qty || ''}
                    onChange={(e) => update(it.id, { qty: Number(e.target.value) || 0 })}
                    aria-label={`Item ${i + 1} quantity`}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    type="number"
                    step="any"
                    className={`${cell} text-right tabular-nums`}
                    value={it.rate || ''}
                    onChange={(e) => update(it.id, { rate: Number(e.target.value) || 0 })}
                    aria-label={`Item ${i + 1} rate`}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    type="number"
                    step="any"
                    className={`${cell} text-right tabular-nums font-medium`}
                    value={it.amount || ''}
                    onChange={(e) => update(it.id, { amount: Number(e.target.value) || 0 })}
                    aria-label={`Item ${i + 1} amount`}
                  />
                </td>
                {showCostCode && (
                  <td className="px-2 py-1.5">
                    <select
                      className={cell}
                      value={it.cost_code}
                      onChange={(e) => update(it.id, { cost_code: e.target.value })}
                      aria-label={`Item ${i + 1} cost code`}
                    >
                      <option value="">—</option>
                      {costCodes.map((c) => (
                        <option key={c.code} value={c.name}>
                          {c.code} · {c.name}
                        </option>
                      ))}
                    </select>
                  </td>
                )}
                <td className="px-2 py-1.5">
                  <select
                    className={cell}
                    value={it.project_id}
                    onChange={(e) => update(it.id, { project_id: e.target.value })}
                    aria-label={`Item ${i + 1} job`}
                  >
                    <option value="">—</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.id}
                      </option>
                    ))}
                  </select>
                </td>
                {showBoq && (
                  <td className="px-2 py-1.5">
                    <input
                      className={cell}
                      list="items-editor-boq"
                      value={it.boq_code}
                      onChange={(e) => update(it.id, { boq_code: e.target.value })}
                      placeholder="A.01"
                      aria-label={`Item ${i + 1} BOQ item`}
                    />
                  </td>
                )}
                <td className="px-2 py-1.5">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => duplicate(it)}
                      className="p-1 text-gray-400 hover:text-blue-600"
                      aria-label={`Duplicate item ${i + 1}`}
                      title="Duplicate line"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(it.id)}
                      className="p-1 text-gray-400 hover:text-red-600"
                      aria-label={`Remove item ${i + 1}`}
                      title="Remove line"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-gray-50 font-medium">
              <td colSpan={5} className="px-2 py-1.5 text-right text-gray-500">
                Items total
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums" data-testid="items-total">
                {formatCurrency(total)}
              </td>
              <td colSpan={cols - 6}></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <datalist id="items-editor-boq">
        {boqItems.map((b) => (
          <option key={b.itemCode} value={b.itemCode}>
            {b.description}
          </option>
        ))}
      </datalist>
      <p className="text-[11px] text-gray-400">
        One bill can carry many materials. Amount follows qty × rate until you type an amount yourself.
      </p>
    </div>
  );
}

export default ItemsEditor;
