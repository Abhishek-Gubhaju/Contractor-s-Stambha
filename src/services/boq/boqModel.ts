// ============================================================================
// boqModel — the bill-of-quantities data rules, with no React and no storage.
//
// The page used to edit nested arrays inline with three different `map` loops,
// and every invalid submission returned silently: a BOQ with no sections could
// not be extended at all, duplicate codes were only caught inside one section,
// and negative quantities produced negative contract value. Keeping the rules
// here makes each of them testable and gives one answer to "what is a valid
// item?" for the page, the importer and the DSR picker.
//
// Codes are compared case- and whitespace-insensitively so "r-101", "R-101 "
// and "R-101" cannot become three rows that only one of which the DSR matches.
// ============================================================================

import type { AppBOQItem, AppBOQSection } from '../../types';

export interface BoqItemDraft {
  itemCode: string;
  description: string;
  unit: string;
  quantity: string;
  rate: string;
  costCode: string;
}

export interface BoqSectionDraft {
  sectionCode: string;
  description: string;
}

export const EMPTY_ITEM_DRAFT: BoqItemDraft = {
  itemCode: '',
  description: '',
  unit: '',
  quantity: '',
  rate: '',
  costCode: '',
};

export const EMPTY_SECTION_DRAFT: BoqSectionDraft = { sectionCode: '', description: '' };

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

let idSeq = 0;

/** Unique enough for a single document, stable across two adds in one ms. */
export function nextBoqId(prefix: 'item' | 'section'): string {
  idSeq = (idSeq + 1) % 100000;
  const random = Math.random().toString(36).slice(2, 8);
  return `boq-${prefix}-${Date.now().toString(36)}-${random}-${idSeq.toString(36)}`;
}

/** Trim only: codes are shown to people, so keep their punctuation. */
export function cleanCode(value: string): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

/** The identity used for duplicate checks and DSR matching. */
export function codeKey(value: string): string {
  return cleanCode(value).toLowerCase();
}

export function itemAmount(quantity: number, rate: number): number {
  return round2((Number(quantity) || 0) * (Number(rate) || 0));
}

/** Stored amount, falling back to qty × rate for older rows with no amount. */
export function amountOf(item: Partial<AppBOQItem>): number {
  const stored = Number(item.amount);
  if (Number.isFinite(stored)) return round2(stored);
  return itemAmount(Number(item.estimatedQuantity), Number(item.rate));
}

export function sectionTotal(section: AppBOQSection): number {
  return round2((section.children || []).reduce((sum, item) => sum + amountOf(item), 0));
}

export function boqTotal(sections: AppBOQSection[]): number {
  return round2((sections || []).reduce((sum, section) => sum + sectionTotal(section), 0));
}

export function allItems(sections: AppBOQSection[]): AppBOQItem[] {
  return (sections || []).flatMap((section) => section.children || []);
}

export function findItem(sections: AppBOQSection[], itemId: string): AppBOQItem | null {
  return allItems(sections).find((item) => item.id === itemId) || null;
}

export function findSectionOfItem(sections: AppBOQSection[], itemId: string): AppBOQSection | null {
  return (sections || []).find((section) => (section.children || []).some((item) => item.id === itemId)) || null;
}

function parseNumber(value: string): number {
  const text = String(value ?? '').trim();
  if (!text) return NaN;
  const n = Number(text);
  return Number.isFinite(n) ? n : NaN;
}

/** Every problem with a draft, in the order a person fills the form. */
export function validateItemDraft(
  sections: AppBOQSection[],
  draft: BoqItemDraft,
  sectionId: string,
  editingItemId?: string
): string[] {
  const errors: string[] = [];
  const section = (sections || []).find((s) => s.id === sectionId);
  if (!section) errors.push('Choose the section this item belongs to.');

  const code = cleanCode(draft.itemCode);
  if (!code) {
    errors.push('An item code is required.');
  } else {
    const key = codeKey(code);
    const clash = allItems(sections).find(
      (item) => item.id !== editingItemId && codeKey(String(item.itemCode || '')) === key
    );
    if (clash) errors.push(`Item code "${code}" is already used by "${clash.description || clash.itemCode}".`);
  }

  if (!String(draft.description ?? '').trim()) errors.push('A description is required.');
  if (!String(draft.unit ?? '').trim()) errors.push('A unit is required (for example cum, kg, sqm).');

  const quantity = parseNumber(draft.quantity);
  if (Number.isNaN(quantity)) errors.push('Enter the estimated quantity as a number.');
  else if (quantity < 0) errors.push('Quantity cannot be negative.');

  const rate = parseNumber(draft.rate);
  if (Number.isNaN(rate)) errors.push('Enter the rate as a number.');
  else if (rate < 0) errors.push('Rate cannot be negative.');

  return errors;
}

export function validateSectionDraft(
  sections: AppBOQSection[],
  draft: BoqSectionDraft,
  editingSectionId?: string
): string[] {
  const errors: string[] = [];
  const code = cleanCode(draft.sectionCode);
  if (!code) {
    errors.push('A section code is required.');
  } else {
    const key = codeKey(code);
    const clash = (sections || []).find((s) => s.id !== editingSectionId && codeKey(String(s.sectionCode || '')) === key);
    if (clash) errors.push(`Section code "${code}" is already used by "${clash.description || clash.sectionCode}".`);
  }
  if (!String(draft.description ?? '').trim()) errors.push('A section description is required.');
  return errors;
}

function assertNoErrors(errors: string[]): void {
  if (errors.length > 0) throw new Error(errors[0]);
}

function withSectionAmounts(sections: AppBOQSection[]): AppBOQSection[] {
  return sections.map((section) => ({ ...section, amount: sectionTotal(section) }));
}

export function addItem(
  sections: AppBOQSection[],
  sectionId: string,
  draft: BoqItemDraft
): { sections: AppBOQSection[]; item: AppBOQItem } {
  assertNoErrors(validateItemDraft(sections, draft, sectionId));
  const section = sections.find((s) => s.id === sectionId)!;
  const quantity = parseNumber(draft.quantity);
  const rate = parseNumber(draft.rate);
  const item: AppBOQItem = {
    id: nextBoqId('item'),
    sectionCode: section.sectionCode,
    itemCode: cleanCode(draft.itemCode),
    description: String(draft.description).trim(),
    unit: String(draft.unit).trim(),
    estimatedQuantity: quantity,
    rate,
    amount: itemAmount(quantity, rate),
    actualMaterialCost: 0,
    actualLaborCost: 0,
    completedQuantity: 0,
    ...(draft.costCode ? { costCode: draft.costCode } : {}),
  };
  const next = sections.map((s) => (s.id === sectionId ? { ...s, children: [...s.children, item] } : s));
  return { sections: withSectionAmounts(next), item };
}

export function updateItem(
  sections: AppBOQSection[],
  itemId: string,
  draft: BoqItemDraft,
  targetSectionId?: string
): AppBOQSection[] {
  const owner = findSectionOfItem(sections, itemId);
  if (!owner) throw new Error('That item no longer exists.');
  const targetId = targetSectionId || owner.id;
  const target = sections.find((s) => s.id === targetId);
  if (!target) throw new Error('Choose a section that still exists.');
  assertNoErrors(validateItemDraft(sections, draft, targetId, itemId));
  const quantity = parseNumber(draft.quantity);
  const rate = parseNumber(draft.rate);
  const edited: AppBOQItem = {
    ...owner.children.find((item) => item.id === itemId)!, // keeps DSR/ledger actuals
    sectionCode: target.sectionCode,
    itemCode: cleanCode(draft.itemCode),
    description: String(draft.description).trim(),
    unit: String(draft.unit).trim(),
    estimatedQuantity: quantity,
    rate,
    amount: itemAmount(quantity, rate),
    costCode: draft.costCode || undefined,
  };

  // Same section: replace in place so the rows do not jump around.
  if (owner.id === targetId) {
    const next = sections.map((section) =>
      section.id !== owner.id
        ? section
        : { ...section, children: section.children.map((item) => (item.id === itemId ? edited : item)) }
    );
    return withSectionAmounts(next);
  }

  // Moved: leave the old section, append to the new one.
  const next = sections.map((section) => {
    if (section.id === owner.id) {
      return { ...section, children: section.children.filter((item) => item.id !== itemId) };
    }
    if (section.id === targetId) {
      return { ...section, children: [...section.children, edited] };
    }
    return section;
  });
  return withSectionAmounts(next);
}

export function removeItem(sections: AppBOQSection[], itemId: string): AppBOQSection[] {
  const next = sections.map((section) => ({
    ...section,
    children: section.children.filter((item) => item.id !== itemId),
  }));
  return withSectionAmounts(next);
}

export function addSection(sections: AppBOQSection[], draft: BoqSectionDraft): { sections: AppBOQSection[]; section: AppBOQSection } {
  assertNoErrors(validateSectionDraft(sections, draft));
  const section: AppBOQSection = {
    id: nextBoqId('section'),
    sectionCode: cleanCode(draft.sectionCode),
    description: String(draft.description).trim(),
    amount: 0,
    isSection: true,
    children: [],
  };
  return { sections: [...sections, section], section };
}

export function updateSection(
  sections: AppBOQSection[],
  sectionId: string,
  draft: BoqSectionDraft
): AppBOQSection[] {
  const existing = sections.find((s) => s.id === sectionId);
  if (!existing) throw new Error('That section no longer exists.');
  assertNoErrors(validateSectionDraft(sections, draft, sectionId));
  const code = cleanCode(draft.sectionCode);
  return sections.map((section) => {
    if (section.id !== sectionId) return section;
    return {
      ...section,
      sectionCode: code,
      description: String(draft.description).trim(),
      // Items carry the section code; keep the two in step so filters and
      // reports that group by code do not split a renamed section in two.
      children: section.children.map((item) => ({ ...item, sectionCode: code })),
    };
  });
}

export function removeSection(sections: AppBOQSection[], sectionId: string): AppBOQSection[] {
  return sections.filter((section) => section.id !== sectionId);
}

export function draftFromItem(item: AppBOQItem): BoqItemDraft {
  return {
    itemCode: item.itemCode || '',
    description: item.description || '',
    unit: item.unit || '',
    quantity: Number.isFinite(Number(item.estimatedQuantity)) ? String(item.estimatedQuantity) : '',
    rate: Number.isFinite(Number(item.rate)) ? String(item.rate) : '',
    costCode: item.costCode || '',
  };
}

export function draftFromSection(section: AppBOQSection): BoqSectionDraft {
  return { sectionCode: section.sectionCode || '', description: section.description || '' };
}
