// ============================================================================
// stockService — the material inventory sub-ledger.
//
// Contractor reality this fixes: materials were expensed the moment they were
// bought, so a job looked expensive the day cement arrived at the store and
// cheap the day it was actually poured. Stock cost now sits in Inventory until
// it is ISSUED to a job, at which point it becomes that job's material cost —
// with the project, cost code and BOQ item it was consumed on.
//
//   • Purchase into store   Dr Inventory (+ VAT)   · Cr AP / Cash
//   • Issue to a job        Dr job material cost   · Cr Inventory
//   • Count adjustment      Dr/Cr Inventory        · Cr/Dr Stock adjustment
//
// Valuation is a weighted moving average derived from the movement rows, so
// nothing is stored twice and re-posting history cannot drift the value:
// value = Σ (qty × rate) over every movement of the item.
//
// Every movement is posted through booksService.saveEntry — the same posting
// engine, locking and voucher series as every other book entry. A reversal
// mirrors BOTH the ledger entry and the quantity, which is why stock entries
// may only be reversed here (see reverseEntry's guard).
// ============================================================================
import {
  saveEntry,
  reverseEntry,
  entryById,
  linesOf,
  todayAD,
  type Entry,
  type EntryType,
} from './booksService';
import { readScoped, writeScoped } from './projectScope';

export const STOCK_ITEMS_KEY = 'contractoros_stock_items';
export const STOCK_MOVEMENTS_KEY = 'contractoros_stock_movements';

export type StockMoveKind = 'receipt' | 'issue' | 'adjust';

export interface StockItem {
  id: string;
  name: string;
  unit: string;
  /** Cost-code master name/code this item's cost rolls up under. */
  costCode: string;
  reorderLevel: number;
}

export interface StockMovement {
  id: string;
  entry_id: string;
  item_id: string;
  kind: StockMoveKind;
  /** Signed: + into stock, − out of stock. */
  qty: number;
  /** Unit cost actually used when the movement was posted. */
  rate: number;
  ad_date: string;
  project_id: string;
  boq_code: string;
  note: string;
  created_at: string;
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

// Each job holds its own store and its own materials: two jobs sharing a site
// must still not share a stock ledger.
function readJSON<T>(key: string, fallback: T): T {
  return readScoped<T>(key, fallback);
}

function writeJSON(key: string, value: unknown) {
  writeScoped(key, value);
}

function emitChange() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('contractoros:stock-changed'));
  }
}

// ---------------------------------------------------------------------------
// Item master
// ---------------------------------------------------------------------------
export function loadStockItems(): StockItem[] {
  const stored = readJSON<StockItem[]>(STOCK_ITEMS_KEY, []);
  if (!Array.isArray(stored)) return [];
  return stored
    .filter((i) => i && typeof i.id === 'string')
    .map((i) => ({
      id: i.id,
      name: String(i.name || i.id),
      unit: String(i.unit || '').trim(),
      costCode: String(i.costCode || 'Materials').trim() || 'Materials',
      reorderLevel: Math.max(0, Number(i.reorderLevel) || 0),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function stockItemById(id: string): StockItem | undefined {
  return loadStockItems().find((i) => i.id === id);
}

function itemSlug(name: string): string {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function upsertStockItem(input: { name: string; unit?: string; costCode?: string; reorderLevel?: number; id?: string }): StockItem {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('An item name is required.');
  const id = input.id || `item:${itemSlug(name) || Date.now().toString(36)}`;
  const item: StockItem = {
    id,
    name,
    unit: String(input.unit || '').trim(),
    costCode: String(input.costCode || 'Materials').trim() || 'Materials',
    reorderLevel: Math.max(0, Number(input.reorderLevel) || 0),
  };
  const list = loadStockItems().filter((i) => i.id !== id);
  writeJSON(STOCK_ITEMS_KEY, [...list, item].sort((a, b) => a.name.localeCompare(b.name)));
  emitChange();
  return item;
}

export function removeStockItem(id: string) {
  if (movementsForItem(id).length > 0) {
    throw new Error('This item already has stock movements — it cannot be deleted. Post a write-off instead.');
  }
  writeJSON(STOCK_ITEMS_KEY, loadStockItems().filter((i) => i.id !== id));
  emitChange();
}

// ---------------------------------------------------------------------------
// Movements
// ---------------------------------------------------------------------------
export function loadMovements(): StockMovement[] {
  const stored = readJSON<StockMovement[]>(STOCK_MOVEMENTS_KEY, []);
  if (!Array.isArray(stored)) return [];
  return stored
    .filter((m) => m && typeof m.entry_id === 'string')
    .map((m) => ({
      ...m,
      qty: round2(m.qty),
      rate: round2(m.rate),
      kind: (['receipt', 'issue', 'adjust'] as const).includes(m.kind) ? m.kind : 'receipt',
      project_id: String(m.project_id || ''),
      boq_code: String(m.boq_code || ''),
      note: String(m.note || ''),
    }));
}

/** Movements of one item, oldest first — the order the average runs in. */
export function movementsForItem(itemId: string): StockMovement[] {
  return loadMovements()
    .filter((m) => m.item_id === itemId)
    .sort((a, b) => a.ad_date.localeCompare(b.ad_date) || a.created_at.localeCompare(b.created_at));
}

export function movementForEntry(entryId: string): StockMovement | undefined {
  return loadMovements().find((m) => m.entry_id === entryId);
}

export interface ItemStock {
  item: StockItem;
  qty: number;
  value: number;
  avg: number;
  shortfall: number; // units below the reorder level (0 when fine)
}

/** Weighted moving average: value ÷ quantity, straight from the movements. */
export function avgCostOf(itemId: string): number {
  let qty = 0;
  let value = 0;
  for (const m of movementsForItem(itemId)) {
    qty = round2(qty + m.qty);
    value = round2(value + m.qty * m.rate);
  }
  return qty > 0 ? round2(value / qty) : 0;
}

export function stockOf(itemId: string): { qty: number; value: number; avg: number } {
  let qty = 0;
  let value = 0;
  for (const m of movementsForItem(itemId)) {
    qty = round2(qty + m.qty);
    value = round2(value + m.qty * m.rate);
  }
  return { qty, value, avg: qty > 0 ? round2(value / qty) : 0 };
}

/** Stock on hand for every item, plus items that need reordering. */
export function stockOnHand(): ItemStock[] {
  return loadStockItems().map((item) => {
    const s = stockOf(item.id);
    return {
      item,
      qty: s.qty,
      value: s.value,
      avg: s.avg,
      shortfall: item.reorderLevel > 0 && s.qty < item.reorderLevel ? round2(item.reorderLevel - s.qty) : 0,
    };
  });
}

/** Total value of everything sitting in the store. */
export function inventoryValue(): number {
  return round2(stockOnHand().reduce((s, r) => s + r.value, 0));
}

// ---------------------------------------------------------------------------
// Posting a movement
// ---------------------------------------------------------------------------
export interface StockMovementInput {
  kind: StockMoveKind;
  item_id: string;
  date: string;
  /** Units. Signed only for an adjustment (count gain +, count loss −). */
  qty: number;
  /** Receipt: unit cost paid. Issue/adjust: defaults to the moving average. */
  rate?: number;
  project_id?: string;
  cost_code?: string;
  boq_code?: string;
  supplier?: string;
  method?: string;
  source?: 'cash' | 'bank' | 'supplier';
  vat_rate?: number;
  vat_included?: boolean;
  due_days?: number;
  ref?: string;
  note?: string;
}

const TYPE_FOR: Record<StockMoveKind, EntryType> = {
  receipt: 'stock-receipt',
  issue: 'stock-issue',
  adjust: 'stock-adjust',
};

export function postStockMovement(input: StockMovementInput): { entry: Entry; movement: StockMovement } {
  const item = stockItemById(input.item_id);
  if (!item) throw new Error('Choose an item from the master first.');
  const date = String(input.date || todayAD()).slice(0, 10);
  const qty = round2(input.qty);

  if (input.kind === 'receipt') {
    if (!(qty > 0)) throw new Error('A receipt needs a quantity greater than zero.');
    if (!(round2(Number(input.rate) || 0) > 0)) throw new Error('A receipt needs the unit cost paid.');
  }
  if (input.kind === 'issue') {
    if (!(qty > 0)) throw new Error('An issue needs a quantity greater than zero.');
    const available = stockOf(item.id).qty;
    if (qty > available) {
      throw new Error(`Only ${available}${item.unit ? ` ${item.unit}` : ''} of ${item.name} on hand — receive stock first.`);
    }
    if (!(input.project_id || '').trim()) throw new Error('An issue must name the job it was consumed on.');
  }
  if (input.kind === 'adjust') {
    if (!qty) throw new Error('An adjustment needs a non-zero quantity difference.');
  }

  const rate = round2(Number(input.rate) || 0) || avgCostOf(item.id);
  if (!(rate > 0)) throw new Error('A unit cost is required — there is no stock value to carry.');

  const base = {
    date,
    ref: String(input.ref || ''),
    note: String(input.note || ''),
    item_name: item.name,
    item_id: item.id,
    rate,
  };

  let form: Record<string, unknown>;
  if (input.kind === 'receipt') {
    form = {
      ...base,
      qty,
      supplier: String(input.supplier || ''),
      source: input.source || 'cash',
      method: input.method || 'cash',
      vat_rate: Number(input.vat_rate) || 0,
      vat_included: Boolean(input.vat_included),
      due_days: Number(input.due_days) || 0,
    };
  } else if (input.kind === 'issue') {
    form = {
      ...base,
      qty,
      project: String(input.project_id || ''),
      cost_code: String(input.cost_code || item.costCode),
      boq_code: String(input.boq_code || ''),
    };
  } else {
    form = { ...base, qty_diff: qty };
  }

  const entry = saveEntry(TYPE_FOR[input.kind], form, { source: 'manual' });

  // The movement is the sub-ledger row: it records the signed quantity and the
  // unit cost the ledger entry was actually posted at.
  const movement: StockMovement = {
    id: `MV-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    entry_id: entry.id,
    item_id: item.id,
    kind: input.kind,
    qty: input.kind === 'issue' ? -qty : qty,
    rate,
    ad_date: date,
    project_id: String(input.project_id || ''),
    boq_code: String(input.boq_code || ''),
    note: String(input.note || ''),
    created_at: new Date().toISOString(),
  };
  try {
    writeJSON(STOCK_MOVEMENTS_KEY, [...loadMovements(), movement]);
  } catch (err) {
    throw new Error(`Ledger entry ${entry.id} was posted but its stock movement could not be saved: ${err instanceof Error ? err.message : String(err)}`);
  }
  emitChange();
  return { entry, movement };
}

/**
 * Reverse a stock entry: mirrors the ledger entry AND the quantity, so the
 * store and the books can never disagree. Reached from the Inventory page.
 */
export function reverseStockEntry(entryId: string, reason: string): Entry {
  const movement = movementForEntry(entryId);
  if (!movement) throw new Error(`${entryId} is not a stock movement.`);
  const reversal = reverseEntry(entryId, reason, undefined, { allowStock: true });
  const mirror: StockMovement = {
    ...movement,
    id: `MV-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    entry_id: reversal.id,
    qty: round2(-movement.qty),
    note: `Reversal of ${entryId}: ${reason.trim()}`,
    created_at: new Date().toISOString(),
  };
  writeJSON(STOCK_MOVEMENTS_KEY, [...loadMovements(), mirror]);
  emitChange();
  return reversal;
}

/** Consumption by job: what each job actually drew from the store. */
export function issuesByProject(): { project_id: string; qty: number; value: number }[] {
  const byProject = new Map<string, { qty: number; value: number }>();
  for (const m of loadMovements()) {
    if (m.kind !== 'issue') continue;
    const key = m.project_id || 'unassigned';
    const row = byProject.get(key) || { qty: 0, value: 0 };
    // Signed, not absolute: a reversed issue carries +qty and must cancel the
    // consumption it mirrors instead of being counted a second time.
    row.qty = round2(row.qty - m.qty);
    row.value = round2(row.value - m.qty * m.rate);
    byProject.set(key, row);
  }
  return [...byProject.entries()]
    .map(([project_id, v]) => ({ project_id, ...v }))
    .sort((a, b) => b.value - a.value);
}

/** Ledger cross-check: the Inventory control account must equal Σ stock value. */
export function inventoryReconciliation(): { ledger: number; store: number; difference: number; balanced: boolean } {
  const ledger = round2(
    loadMovements()
      .map((m) => entryById(m.entry_id))
      .filter((e): e is Entry => Boolean(e))
      .reduce((s, e) => s + linesOf(e.id).filter((l) => l.account_id === 'acc:inventory').reduce((t, l) => t + l.debit - l.credit, 0), 0)
  );
  const store = inventoryValue();
  const difference = round2(ledger - store);
  return { ledger, store, difference, balanced: Math.abs(difference) < 0.005 };
}
