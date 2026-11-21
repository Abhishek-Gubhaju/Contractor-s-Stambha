// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { loadParties, ensureParty, upsertParty, partyByName, removeParty, partiesOfType, panLooksValid } from './partyService';

beforeEach(() => localStorage.clear());

describe('party master', () => {
  it('starts empty and adopts a name from a posting', () => {
    expect(loadParties()).toEqual([]);
    const p = ensureParty('Himalayan Hardware', 'supplier');
    expect(p?.name).toBe('Himalayan Hardware');
    expect(p?.type).toBe('supplier');
    expect(loadParties()).toHaveLength(1);
    expect(ensureParty('himalayan hardware')).toBeTruthy(); // same party, case-insensitive
    expect(loadParties()).toHaveLength(1);
  });

  it('keeps PAN and credit terms once entered', () => {
    upsertParty({ name: 'Gyan Constructions', type: 'client', pan: '601234567', address: 'Kathmandu', creditDays: 30 });
    const p = partyByName('Gyan Constructions');
    expect(p?.pan).toBe('601234567');
    expect(p?.creditDays).toBe(30);
    expect(panLooksValid(p!.pan)).toBe(true);
    expect(panLooksValid('12345')).toBe(false);
  });

  it('promotes a party seen on both sides to "both"', () => {
    ensureParty('Rai Traders', 'client');
    const both = ensureParty('Rai Traders', 'supplier');
    expect(both?.type).toBe('both');
    expect(partiesOfType('client').map((p) => p.name)).toContain('Rai Traders');
    expect(partiesOfType('supplier').map((p) => p.name)).toContain('Rai Traders');
  });

  it('does not overwrite fields that were already set', () => {
    upsertParty({ name: 'A', pan: '111111111' });
    upsertParty({ name: 'A', address: 'Pokhara' });
    const p = partyByName('A');
    expect(p?.pan).toBe('111111111');
    expect(p?.address).toBe('Pokhara');
  });

  it('removes a party without touching posted entries', () => {
    upsertParty({ name: 'Old Supplier' });
    removeParty(partyByName('Old Supplier')!.id);
    expect(partyByName('Old Supplier')).toBeNull();
  });

  it('gives non-Latin names a real id and adopts them only once', () => {
    const first = ensureParty('राम बहादुर कन्स्ट्रक्शन', 'supplier');
    expect(first?.id).toBeTruthy();
    expect(first?.id).not.toBe('');
    const again = ensureParty('राम बहादुर कन्स्ट्रक्शन');
    expect(again?.id).toBe(first?.id);
    expect(loadParties()).toHaveLength(1);

    upsertParty({ name: 'राम बहादुर कन्स्ट्रक्शन', pan: '601234567' });
    expect(partyByName('राम बहादुर कन्स्ट्रक्शन')?.pan).toBe('601234567');
    expect(loadParties()).toHaveLength(1);
  });
});
