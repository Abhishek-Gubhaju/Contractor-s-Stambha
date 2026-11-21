// ============================================================================
// partyService — clients and suppliers as first-class records.
//
// Why this exists: a Nepali tax invoice must print the counterparty's PAN, and
// a purchase register must list the supplier's PAN bill by bill. Typing those
// numbers on every document guarantees they eventually disagree. The master is
// the single source: the entry form auto-fills from it, and a posting with a
// new name adopts that name as a party so it can be completed later.
// ============================================================================

import { readScoped, writeScoped } from './projectScope';

export const PARTIES_KEY = 'contractoros_parties';

export type PartyType = 'client' | 'supplier' | 'both';

export interface Party {
  id: string;
  name: string;
  type: PartyType;
  pan: string;
  address: string;
  phone: string;
  /** Default credit days applied to new bills/invoices for this party. */
  creditDays: number;
  note: string;
}

export function slugParty(name: string): string {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

let fallbackSeq = 0;
/** Non-Latin names (Devanagari, for instance) slug to '' — they still need an id. */
function fallbackPartyId(): string {
  fallbackSeq = (fallbackSeq + 1) % 10000;
  return `party-${Date.now().toString(36)}-${fallbackSeq.toString(36)}`;
}

/** A stable, non-empty id for a party name. */
export function partyIdFor(name: string): string {
  return slugParty(name) || fallbackPartyId();
}

// A party master belongs to the job's books: another company's clients and
// suppliers never appear in this job's pickers or printed documents.
export function loadParties(): Party[] {
  const rows = readScoped<Party[]>(PARTIES_KEY, []);
  return Array.isArray(rows) ? rows.filter((p) => p && p.name) : [];
}

function saveAll(rows: Party[]) {
  writeScoped(PARTIES_KEY, rows);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('contractoros:books-changed'));
  }
}

export function partyByName(name: string): Party | null {
  const clean = String(name || '').trim();
  const key = slugParty(clean);
  const rows = loadParties();
  if (!key) {
    // Names that do not transliterate are matched on the name itself, so a
    // Nepali supplier is adopted once instead of being re-created every bill.
    return rows.find((p) => p.name.trim().toLowerCase() === clean.toLowerCase()) || null;
  }
  return rows.find((p) => p.id === key || slugParty(p.name) === key) || null;
}

/** Find-or-create by name; never rejects a posting for an unknown party. */
export function ensureParty(name: string, type: PartyType = 'both'): Party | null {
  const clean = String(name || '').trim();
  if (!clean) return null;
  const existing = partyByName(clean);
  if (existing) {
    // A party first seen as a client can later be billed by a supplier.
    if (existing.type !== 'both' && existing.type !== type) {
      const merged: Party = { ...existing, type: 'both' };
      saveAll(loadParties().map((p) => (p.id === existing.id ? merged : p)));
      return merged;
    }
    return existing;
  }
  const party: Party = {
    id: partyIdFor(clean),
    name: clean,
    type,
    pan: '',
    address: '',
    phone: '',
    creditDays: 0,
    note: '',
  };
  saveAll([...loadParties(), party]);
  return party;
}

export function upsertParty(input: Partial<Party> & { name: string }): Party {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('A party name is required.');
  const id = input.id || partyIdFor(name);
  const existing = loadParties().find((p) => p.id === id) || partyByName(name);
  const next: Party = {
    id: existing?.id || id,
    name,
    type: input.type || existing?.type || 'both',
    pan: String(input.pan ?? existing?.pan ?? '').trim(),
    address: String(input.address ?? existing?.address ?? '').trim(),
    phone: String(input.phone ?? existing?.phone ?? '').trim(),
    creditDays: Math.max(0, Number(input.creditDays ?? existing?.creditDays ?? 0) || 0),
    note: String(input.note ?? existing?.note ?? '').trim(),
  };
  saveAll([...loadParties().filter((p) => p.id !== next.id && p.id !== id), next].sort((a, b) => a.name.localeCompare(b.name)));
  return next;
}

export function removeParty(id: string) {
  saveAll(loadParties().filter((p) => p.id !== id));
}

export function partiesOfType(type: 'client' | 'supplier'): Party[] {
  return loadParties()
    .filter((p) => p.type === type || p.type === 'both')
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** PAN as printed: 9 digits for an individual/firm, or blank. */
export function panLooksValid(pan: string): boolean {
  return /^\d{9}$/.test(String(pan || '').trim());
}
