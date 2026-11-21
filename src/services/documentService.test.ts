// Pure document arithmetic: item normalisation, the totals engine and the
// amount-in-words line printed at the foot of every bill.
import { describe, it, expect } from 'vitest';
import {
  blankItem,
  normalizeItems,
  documentTotals,
  groupBase,
  numberToWords,
  amountInWords,
  itemsSubtotal,
  type DocItem,
} from './documentService';

const item = (patch: Partial<DocItem>): DocItem => ({ ...blankItem(), ...patch });

describe('item normalisation', () => {
  it('drops blank rows and renumbers the rest', () => {
    const items = normalizeItems([
      { id: 'a', description: 'Cement', qty: '10', rate: '800', cost_code: 'Materials' },
      { id: 'b', description: '', qty: '', rate: '' },
      { id: 'c', description: 'Rod', qty: 2, rate: '9500', cost_code: 'Materials' },
    ]);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.line_no)).toEqual([1, 2]);
    expect(items[0].amount).toBe(8000);
    expect(items[1].amount).toBe(19000);
  });

  it('keeps a hand-typed amount (a lump-sum transport charge)', () => {
    const [transport] = normalizeItems([{ description: 'Transport', qty: 0, rate: 0, amount: 1500 }]);
    expect(transport.amount).toBe(1500);
  });

  it('only carries a per-line VAT rate when one was given', () => {
    const [withRate, without] = normalizeItems([
      { description: 'Cement', amount: 100, vat_rate: 13 },
      { description: 'Exempt sand', amount: 100 },
    ]);
    expect(withRate.vat_rate).toBe(13);
    expect(without.vat_rate).toBeUndefined();
  });
});

describe('document totals', () => {
  const items = [
    item({ description: 'Cement', amount: 10000, cost_code: 'Materials', project_id: 'PRJ-001' }),
    item({ description: 'Rod', amount: 20000, cost_code: 'Materials', project_id: 'PRJ-001' }),
  ];

  it('adds 13% VAT on the taxable value and keeps the balance', () => {
    const t = documentTotals(items, { vatRate: 13 });
    expect(t.subtotal).toBe(30000);
    expect(t.base).toBe(30000);
    expect(t.vat).toBe(3900);
    expect(t.total).toBe(33900);
    expect(t.payable).toBe(33900);
  });

  it('splits a VAT-inclusive bill backwards so the total never drifts', () => {
    const t = documentTotals([item({ amount: 11300 })], { vatRate: 13, vatIncluded: true });
    expect(t.base).toBe(10000);
    expect(t.vat).toBe(1300);
    expect(t.total).toBe(11300);
  });

  it('honours a per-line rate on a mixed bill (13% goods + 0% exempt)', () => {
    const mixed = [
      item({ description: 'Cement', amount: 10000, vat_rate: 13 }),
      item({ description: 'Exempt earth', amount: 5000, vat_rate: 0 }),
    ];
    const t = documentTotals(mixed, { vatRate: 13 });
    expect(t.base).toBe(15000);
    expect(t.vat).toBe(1300); // only the cement is taxed
  });

  it('takes TDS and retention off the taxable value, never off VAT', () => {
    const t = documentTotals(items, { vatRate: 13, tdsRate: 1.5, retentionPct: 5 });
    expect(t.vat).toBe(3900);
    expect(t.tds).toBe(450); // 1.5% of 30,000
    expect(t.retention).toBe(1500); // 5% of 30,000
    expect(t.payable).toBe(round(33900 - 450 - 1500));
  });

  it('spreads a document discount across lines before computing VAT', () => {
    const t = documentTotals(items, { vatRate: 13, discount: 3000 });
    expect(t.base).toBe(27000);
    expect(t.vat).toBe(3510);
    expect(round(t.lines.reduce((s, l) => s + l.base, 0))).toBe(27000);
  });

  it('groups item lines by cost code × job × BOQ item for posting', () => {
    const mixed = [
      item({ amount: 1000, cost_code: 'Materials', project_id: 'PRJ-001', boq_code: 'A.01' }),
      item({ amount: 2000, cost_code: 'Materials', project_id: 'PRJ-001', boq_code: 'A.01' }),
      item({ amount: 3000, cost_code: 'Transport', project_id: 'PRJ-001' }),
      item({ amount: 4000, cost_code: 'Materials', project_id: 'PRJ-002', boq_code: 'B.01' }),
    ];
    const t = documentTotals(mixed, { vatRate: 0 });
    const groups = groupBase(mixed, t.lines);
    expect(groups).toHaveLength(3);
    expect(groups.find((g) => g.boq_code === 'A.01')?.amount).toBe(3000);
    expect(groups.find((g) => g.project_id === 'PRJ-002')?.amount).toBe(4000);
    expect(itemsSubtotal(mixed)).toBe(10000);
  });
});

describe('amount in words (Nepali numbering)', () => {
  it('rolls up lakh and crore the way a bill prints it', () => {
    expect(numberToWords(0)).toBe('Zero');
    expect(numberToWords(999)).toBe('Nine Hundred Ninety Nine');
    expect(numberToWords(1234)).toBe('One Thousand Two Hundred Thirty Four');
    expect(numberToWords(125000)).toBe('One Lakh Twenty Five Thousand');
    expect(numberToWords(10000000)).toBe('One Crore');
  });

  it('appends paise only when there are any', () => {
    expect(amountInWords(125000)).toBe('Rupees One Lakh Twenty Five Thousand Only');
    expect(amountInWords(125000.5)).toBe('Rupees One Lakh Twenty Five Thousand and Fifty Paise Only');
  });
});

function round(n: number) {
  return Math.round(n * 100) / 100;
}
