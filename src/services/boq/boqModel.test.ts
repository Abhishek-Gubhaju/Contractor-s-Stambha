import { describe, expect, it } from 'vitest';
import type { AppBOQItem, AppBOQSection } from '../../types';
import {
  addItem,
  addSection,
  amountOf,
  boqTotal,
  codeKey,
  draftFromItem,
  findSectionOfItem,
  itemAmount,
  nextBoqId,
  removeItem,
  removeSection,
  sectionTotal,
  updateItem,
  updateSection,
  validateItemDraft,
  validateSectionDraft,
} from './boqModel';

const item = (over: Partial<AppBOQItem> = {}): AppBOQItem => ({
  id: 'i-1',
  sectionCode: 'R',
  itemCode: 'R-101',
  description: 'Earthwork',
  unit: 'cum',
  estimatedQuantity: 1000,
  rate: 550,
  amount: 550000,
  actualMaterialCost: 0,
  actualLaborCost: 0,
  completedQuantity: 0,
  ...over,
});

const section = (over: Partial<AppBOQSection> = {}): AppBOQSection => ({
  id: 's-1',
  sectionCode: 'R',
  description: 'Road works',
  amount: 550000,
  isSection: true,
  children: [item()],
  ...over,
});

const draft = (over: Record<string, string> = {}) => ({
  itemCode: 'R-102',
  description: 'Backfill',
  unit: 'cum',
  quantity: '10',
  rate: '125.5',
  costCode: '',
  ...over,
});

describe('BOQ codes', () => {
  it('compares codes case- and whitespace-insensitively', () => {
    expect(codeKey('  r-101  ')).toBe('r-101');
    expect(codeKey('R-101')).toBe(codeKey('r-101'));
  });

  it('creates unique ids even within the same millisecond', () => {
    const ids = new Set(Array.from({ length: 50 }, () => nextBoqId('item')));
    expect(ids.size).toBe(50);
  });
});

describe('BOQ amounts', () => {
  it('rounds quantity × rate to paisa', () => {
    expect(itemAmount(3, 0.1)).toBe(0.3);
    expect(itemAmount(1000, 550)).toBe(550000);
  });

  it('falls back to quantity × rate when an old row has no amount', () => {
    expect(amountOf({ estimatedQuantity: 2, rate: 5 } as AppBOQItem)).toBe(10);
    expect(amountOf({ amount: 7.006, estimatedQuantity: 0, rate: 0 } as AppBOQItem)).toBe(7.01);
  });

  it('totals sections and the whole BOQ', () => {
    expect(sectionTotal(section())).toBe(550000);
    expect(boqTotal([section(), section({ id: 's-2', children: [item({ id: 'i-2', amount: 450 })] })])).toBe(550450);
  });
});

describe('adding items', () => {
  it('appends a fully formed item and refreshes the section amount', () => {
    const { sections, item: added } = addItem([section()], 's-1', draft());
    expect(sections[0].children).toHaveLength(2);
    expect(added).toMatchObject({
      sectionCode: 'R',
      itemCode: 'R-102',
      description: 'Backfill',
      unit: 'cum',
      estimatedQuantity: 10,
      rate: 125.5,
      amount: 1255,
      actualMaterialCost: 0,
      actualLaborCost: 0,
      completedQuantity: 0,
    });
    expect(sections[0].amount).toBe(551255);
  });

  it('trims the code and description instead of storing stray spaces', () => {
    const { item: added } = addItem([section()], 's-1', draft({ itemCode: '  R-102 ', description: ' Backfill ' }));
    expect(added.itemCode).toBe('R-102');
    expect(added.description).toBe('Backfill');
  });

  it('refuses a missing section', () => {
    expect(() => addItem([section()], 'missing', draft())).toThrow(/section/i);
  });

  it('refuses duplicates across sections, not just within one', () => {
    const other = section({ id: 's-2', sectionCode: 'B', children: [item({ id: 'i-9', itemCode: 'b-202' })] });
    expect(() => addItem([section(), other], 's-1', draft({ itemCode: ' B-202 ' }))).toThrow(/already used/i);
  });

  it('refuses negative quantities and rates', () => {
    expect(() => addItem([section()], 's-1', draft({ quantity: '-1' }))).toThrow(/negative/i);
    expect(() => addItem([section()], 's-1', draft({ rate: '-0.01' }))).toThrow(/negative/i);
  });
});

describe('item validation', () => {
  it('reports every problem at once', () => {
    const errors = validateItemDraft([section()], { itemCode: '', description: '', unit: '', quantity: '', rate: '', costCode: '' }, 's-1');
    expect(errors).toEqual([
      'An item code is required.',
      'A description is required.',
      'A unit is required (for example cum, kg, sqm).',
      'Enter the estimated quantity as a number.',
      'Enter the rate as a number.',
    ]);
  });

  it('rejects non-numeric quantities instead of silently storing zero', () => {
    expect(validateItemDraft([section()], draft({ quantity: 'ten' }), 's-1')).toContain(
      'Enter the estimated quantity as a number.'
    );
  });

  it('allows zero quantity and zero rate', () => {
    expect(validateItemDraft([section()], draft({ quantity: '0', rate: '0' }), 's-1')).toEqual([]);
  });

  it('lets an edited item keep its own code', () => {
    expect(validateItemDraft([section()], draft({ itemCode: 'R-101' }), 's-1', 'i-1')).toEqual([]);
    expect(validateItemDraft([section()], draft({ itemCode: 'R-101' }), 's-1')).toContain(
      'Item code "R-101" is already used by "Earthwork".'
    );
  });

  it('does not treat a quantity of "0" as blank', () => {
    expect(validateItemDraft([section()], draft({ quantity: '0' }), 's-1')).toEqual([]);
  });
});

describe('editing items', () => {
  it('keeps actuals and completed quantity while changing the contract figures', () => {
    const base = section({ children: [item({ actualMaterialCost: 900, actualLaborCost: 400, completedQuantity: 25 })] });
    const next = updateItem([base], 'i-1', draft({ itemCode: 'R-101', description: 'Earthwork (revised)', quantity: '1200', rate: '600' }));
    expect(next[0].children[0]).toMatchObject({
      id: 'i-1',
      description: 'Earthwork (revised)',
      estimatedQuantity: 1200,
      rate: 600,
      amount: 720000,
      actualMaterialCost: 900,
      actualLaborCost: 400,
      completedQuantity: 25,
    });
    expect(next[0].amount).toBe(720000);
  });

  it('refuses to edit an item that is gone', () => {
    expect(() => updateItem([section()], 'nope', draft())).toThrow(/no longer exists/i);
  });

  it('does not allow renaming onto another item code', () => {
    const base = section({ children: [item(), item({ id: 'i-2', itemCode: 'R-102' })] });
    expect(() => updateItem([base], 'i-2', draft({ itemCode: 'r-101' }))).toThrow(/already used/i);
  });

  it('moves an item to another section and updates both totals', () => {
    const bridge = section({ id: 's-2', sectionCode: 'B', description: 'Bridge works', children: [] });
    const next = updateItem([section(), bridge], 'i-1', draft({ itemCode: 'R-101', quantity: '10', rate: '50' }), 's-2');
    expect(next[0].children).toHaveLength(0);
    expect(next[0].amount).toBe(0);
    expect(next[1].children).toHaveLength(1);
    expect(next[1].children[0]).toMatchObject({ id: 'i-1', sectionCode: 'B', amount: 500 });
    expect(next[1].amount).toBe(500);
  });

  it('refuses to move an item into a section that is gone', () => {
    expect(() => updateItem([section()], 'i-1', draft(), 'missing')).toThrow(/section/i);
  });

  it('round-trips an item through a draft without losing numbers', () => {
    const source = item();
    const back = draftFromItem(source);
    expect(back).toMatchObject({ itemCode: 'R-101', quantity: '1000', rate: '550' });
  });
});

describe('removing items', () => {
  it('removes only the chosen item and updates the section amount', () => {
    const base = section({ children: [item(), item({ id: 'i-2', itemCode: 'R-102', amount: 1000 })] });
    const next = removeItem([base], 'i-1');
    expect(next[0].children).toHaveLength(1);
    expect(next[0].children[0].id).toBe('i-2');
    expect(next[0].amount).toBe(1000);
  });

  it('is a no-op for an unknown id', () => {
    const next = removeItem([section()], 'missing');
    expect(next[0].children).toHaveLength(1);
  });

  it('finds the owning section of an item', () => {
    expect(findSectionOfItem([section()], 'i-1')?.id).toBe('s-1');
    expect(findSectionOfItem([section()], 'nope')).toBeNull();
  });
});

describe('sections', () => {
  it('adds a section with no items and a zero amount', () => {
    const { sections, section: added } = addSection([], { sectionCode: ' B ', description: ' Bridge works ' });
    expect(sections).toHaveLength(1);
    expect(added).toMatchObject({ sectionCode: 'B', description: 'Bridge works', amount: 0, isSection: true, children: [] });
  });

  it('refuses duplicate section codes', () => {
    expect(() => addSection([section()], { sectionCode: 'r', description: 'Duplicate' })).toThrow(/already used/i);
    expect(validateSectionDraft([section()], { sectionCode: 'R', description: 'x' })).toHaveLength(1);
  });

  it('requires a code and a description', () => {
    expect(validateSectionDraft([], { sectionCode: '', description: '' })).toEqual([
      'A section code is required.',
      'A section description is required.',
    ]);
  });

  it('renames a section and carries the code onto its items', () => {
    const next = updateSection([section()], 's-1', { sectionCode: 'RD', description: 'Road works (revised)' });
    expect(next[0].sectionCode).toBe('RD');
    expect(next[0].children[0].sectionCode).toBe('RD');
    expect(next[0].children[0].itemCode).toBe('R-101'); // item codes are not rewritten
  });

  it('deletes a section and everything under it', () => {
    expect(removeSection([section(), section({ id: 's-2', sectionCode: 'B' })], 's-1')).toHaveLength(1);
    expect(removeSection([section()], 's-1')).toEqual([]);
  });

  it('recomputes stored section amounts after an add', () => {
    const base = section({ amount: 0 });
    const { sections } = addItem([base], 's-1', draft());
    expect(sections[0].amount).toBe(551255);
  });
});
