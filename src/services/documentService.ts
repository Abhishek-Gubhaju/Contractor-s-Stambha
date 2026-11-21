// ============================================================================
// documentService — the ITEM LINES of a contractor document.
//
// A real supplier bill is rarely one figure: a hardware bill is cement, rods,
// binding wire and a transport charge on the same paper; a running bill is ten
// BOQ items. The double-entry core only needs the totals (one expense line per
// cost code / job / BOQ item), so item detail lives here, alongside the entry,
// and the posting engine aggregates it. That keeps ONE line table for the books
// while a printed bill still lists every item.
//
//   • DocItem       — one row exactly as it appears on the paper bill.
//   • documentTotals — subtotal → discount → VAT → TDS → retention → payable,
//                      per-line VAT rates honoured, every figure 2 dp.
//   • amountInWords  — Nepali numbering (crore / lakh / thousand), as printed.
//   • groupBase      — items rolled up for posting (cost code × job × BOQ item).
// ============================================================================

import { readScoped, writeScopedStrict } from './projectScope';

export const DOC_ITEMS_KEY = 'contractoros_entry_items';

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export interface DocItem {
  id: string;
  /** 1-based position on the printed document. */
  line_no: number;
  description: string;
  unit: string;
  qty: number;
  rate: number;
  /** Line total: qty × rate, or the figure typed when it differs. */
  amount: number;
  /** Cost category (cost-code name) this line is booked to. */
  cost_code: string;
  project_id: string;
  boq_code: string;
  /** Optional per-line VAT override; undefined = the document's rate. */
  vat_rate?: number;
}

export interface StoredDocItem extends DocItem {
  entry_id: string;
}

// Item lines ride with their entry, and the entry belongs to one job.
function readJSON<T>(key: string, fallback: T): T {
  return readScoped<T>(key, fallback);
}

let seq = 0;
function nextItemId(): string {
  seq = (seq + 1) % 10000;
  return `it-${Date.now().toString(36)}-${seq.toString(36)}`;
}

/** A blank row for the editor. */
export function blankItem(defaults: Partial<DocItem> = {}): DocItem {
  return {
    id: nextItemId(),
    line_no: 0,
    description: '',
    unit: '',
    qty: 0,
    rate: 0,
    amount: 0,
    cost_code: '',
    project_id: '',
    boq_code: '',
    ...defaults,
  };
}

/**
 * Normalise rows coming from a form: numeric strings become numbers, a line
 * whose amount is not typed is qty × rate, and empty rows are dropped. Line
 * numbers are reassigned so a deleted row never leaves a gap on the print.
 */
export function normalizeItems(input: unknown, defaults: Partial<DocItem> = {}): DocItem[] {
  if (!Array.isArray(input)) return [];
  const out: DocItem[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, any>;
    const qty = round2(Number(r.qty) || 0);
    const rate = round2(Number(r.rate) || 0);
    const typed = round2(Number(r.amount) || 0);
    const amount = typed || round2(qty * rate);
    const description = String(r.description ?? '').trim();
    if (!description && !amount) continue; // blank row
    const vatRaw = r.vat_rate;
    const item: DocItem = {
      id: String(r.id || nextItemId()),
      line_no: 0,
      description,
      unit: String(r.unit ?? defaults.unit ?? '').trim(),
      qty,
      rate,
      amount,
      cost_code: String(r.cost_code ?? defaults.cost_code ?? '').trim(),
      project_id: String(r.project_id ?? defaults.project_id ?? '').trim(),
      boq_code: String(r.boq_code ?? defaults.boq_code ?? '').trim(),
      ...(vatRaw === '' || vatRaw === null || typeof vatRaw === 'undefined' ? {} : { vat_rate: Number(vatRaw) || 0 }),
    };
    out.push(item);
  }
  return out.map((item, i) => ({ ...item, line_no: i + 1 }));
}

export function itemsSubtotal(items: DocItem[]): number {
  return round2(items.reduce((s, it) => s + (Number(it.amount) || 0), 0));
}

export interface DocumentTotals {
  /** Σ line amounts, before discount. */
  subtotal: number;
  discount: number;
  /** Taxable value (VAT-exclusive), after discount. */
  base: number;
  vat: number;
  /** TDS withheld on the taxable value, never on VAT. */
  tds: number;
  /** Retention held back, also on the taxable value. */
  retention: number;
  /** Rounding adjustment added to the payable (cash-rounding). */
  roundOff: number;
  /** base + vat — the value of the supply. */
  total: number;
  /** total − tds − retention + roundOff — what actually moves. */
  payable: number;
  /** Per-item base and VAT, index-aligned with the normalised items. */
  lines: { base: number; vat: number }[];
}

/**
 * The one totals engine. Preview, save and print all call it, so a printed
 * invoice can never disagree with the entry it came from.
 *
 * VAT is computed PER LINE (a bill can mix 13% goods with a 0% exempt item);
 * the document rate is only the default. TDS and retention are percentages of
 * the taxable value — withholding is never charged on VAT.
 */
export function documentTotals(
  items: DocItem[],
  opts: { vatRate?: number; vatIncluded?: boolean; tdsRate?: number; retentionPct?: number; discount?: number; roundOff?: number } = {}
): DocumentTotals {
  const docRate = Number(opts.vatRate) || 0;
  const included = Boolean(opts.vatIncluded);
  const rawSubtotal = itemsSubtotal(items);
  const discount = Math.min(rawSubtotal, Math.max(0, round2(opts.discount || 0)));

  // Spread the discount across lines in proportion, so per-line VAT stays
  // right after a document-level discount.
  const factor = rawSubtotal > 0 ? (rawSubtotal - discount) / rawSubtotal : 0;

  const lines: { base: number; vat: number }[] = [];
  let base = 0;
  let vat = 0;
  for (const it of items) {
    const gross = round2((Number(it.amount) || 0) * factor);
    const rate = typeof it.vat_rate === 'number' ? it.vat_rate : docRate;
    let lineBase = gross;
    let lineVat = 0;
    if (rate > 0) {
      if (included) {
        lineBase = round2(gross / (1 + rate / 100));
        lineVat = round2(gross - lineBase);
      } else {
        lineVat = round2((gross * rate) / 100);
      }
    }
    base = round2(base + lineBase);
    vat = round2(vat + lineVat);
    lines.push({ base: lineBase, vat: lineVat });
  }

  const tds = round2((base * (Number(opts.tdsRate) || 0)) / 100);
  const retention = round2((base * (Number(opts.retentionPct) || 0)) / 100);
  const roundOff = round2(opts.roundOff || 0);
  const total = round2(base + vat);
  const payable = round2(total - tds - retention + roundOff);
  return { subtotal: rawSubtotal, discount, base, vat, tds, retention, roundOff, total, payable, lines };
}

export interface PostingGroup {
  cost_code: string;
  project_id: string;
  boq_code: string;
  /** Taxable value of the lines in this group. */
  amount: number;
}

/**
 * Roll item lines up to the dimensions the ledger keeps: cost code × job ×
 * BOQ item. Ten cement lines on one bill become ONE expense line; two jobs on
 * one bill stay two lines, because job costing must see each job's share.
 */
export function groupBase(items: DocItem[], lines: { base: number }[]): PostingGroup[] {
  const map = new Map<string, PostingGroup>();
  items.forEach((it, i) => {
    const key = `${it.cost_code}|${it.project_id}|${it.boq_code}`;
    const existing = map.get(key);
    const amount = round2(lines[i]?.base || 0);
    if (existing) existing.amount = round2(existing.amount + amount);
    else map.set(key, { cost_code: it.cost_code, project_id: it.project_id, boq_code: it.boq_code, amount });
  });
  return [...map.values()].filter((g) => g.amount !== 0);
}

// ---------------------------------------------------------------------------
// Storage — item lines ride with their entry
// ---------------------------------------------------------------------------
export function allDocItems(): StoredDocItem[] {
  const rows = readJSON<StoredDocItem[]>(DOC_ITEMS_KEY, []);
  return Array.isArray(rows) ? rows : [];
}

export function docItemsOf(entryId: string): DocItem[] {
  return allDocItems()
    .filter((r) => r.entry_id === entryId)
    .sort((a, b) => a.line_no - b.line_no)
    .map(({ entry_id, ...rest }) => rest);
}

export function saveDocItems(entryId: string, items: DocItem[]): StoredDocItem[] {
  const rows: StoredDocItem[] = normalizeItems(items).map((it) => ({ ...it, entry_id: entryId }));
  const rest = allDocItems().filter((r) => r.entry_id !== entryId);
  writeScopedStrict(DOC_ITEMS_KEY, [...rest, ...rows]);
  return rows;
}

export function removeDocItems(entryId: string) {
  const rest = allDocItems().filter((r) => r.entry_id !== entryId);
  writeScopedStrict(DOC_ITEMS_KEY, rest);
}

export function hasDocItems(entryId: string): boolean {
  return allDocItems().some((r) => r.entry_id === entryId);
}

// ---------------------------------------------------------------------------
// Amount in words — Nepali numbering, as printed on a bill
// ---------------------------------------------------------------------------
const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n: number): string {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return `${TENS[t]}${o ? ` ${ONES[o]}` : ''}`;
}

function threeDigits(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (rest) parts.push(twoDigits(rest));
  return parts.join(' ');
}

/** Whole-number words in the lakh/crore system used across Nepal. */
export function numberToWords(value: number): string {
  let n = Math.floor(Math.abs(Number(value) || 0));
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 10000000);
  n %= 10000000;
  const lakh = Math.floor(n / 100000);
  n %= 100000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  if (crore) parts.push(`${numberToWords(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (n) parts.push(threeDigits(n));
  return parts.join(' ');
}

/** "Rupees One Lakh Twelve Thousand Five Hundred and Fifty Paise Only". */
export function amountInWords(value: number, currency = 'Rupees'): string {
  const v = round2(Math.abs(Number(value) || 0));
  const whole = Math.floor(v);
  const paise = Math.round((v - whole) * 100);
  const head = `${currency} ${numberToWords(whole)}`;
  const tail = paise > 0 ? ` and ${twoDigits(paise)} Paise` : '';
  return `${head}${tail} Only`;
}
