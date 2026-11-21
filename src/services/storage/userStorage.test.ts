// @vitest-environment jsdom
// Two accounts must never see each other's books. The namespace layer is the
// only thing standing between them, so it is tested directly: mapping, reads,
// writes, listing, clearing, adoption of pre-account data, and purging.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  adoptLegacyData,
  installUserStorage,
  legacyAppKeys,
  legacyOwner,
  purgeUserData,
  setStorageNamespace,
  setStorageWriteListener,
  userKeyFor,
  userStorageInstalled,
  usersWithData,
  userKeys,
} from './userStorage';
import { scopedKey } from '../projectScope';
import { saveEntry } from '../booksService';
import { backupSnapshot } from '../ledgerService';

const A = 'user-a';
const B = 'user-b';

function wipe() {
  setStorageNamespace(null);
  purgeUserData(A);
  purgeUserData(B);
  localStorage.clear();
}

beforeEach(() => {
  if (!userStorageInstalled()) installUserStorage();
  wipe();
});

describe('93. storage namespaces', () => {
  it('notifies the durable-mirror listener after every save', () => {
    const seen: Array<[string, string | null]> = [];
    setStorageWriteListener((key, value) => seen.push([key, value]));
    try {
      setStorageNamespace(A);
      localStorage.setItem('contractoros_boq', '[]');
      localStorage.removeItem('contractoros_boq');
      expect(seen).toEqual([
        ['contractoros_boq', '[]'],
        ['contractoros_boq', null],
      ]);
    } finally {
      setStorageWriteListener(null);
    }
  });

  it('maps app keys into a namespace and leaves credentials and preferences alone', () => {
    expect(userKeyFor(A, 'contractoros_boq')).toBe(`contractoros_u:${A}::contractoros_boq`);
    expect(userKeyFor(A, 'contractoros_boq::PRJ-001')).toBe(`contractoros_u:${A}::contractoros_boq::PRJ-001`);
    expect(userKeyFor(A, 'contractoros_auth_users')).toBe('contractoros_auth_users');
    expect(userKeyFor(A, 'darkMode')).toBe('darkMode');
    expect(userKeyFor(null, 'contractoros_boq')).toBe('contractoros_boq');
  });

  it('gives each account its own data, down to the project key', () => {
    setStorageNamespace(A);
    localStorage.setItem(scopedKey('contractoros_boq', 'PRJ-001'), JSON.stringify([{ id: 'a-1' }]));
    localStorage.setItem('contractoros_entries', '[{"id":"entry-a"}]');

    setStorageNamespace(B);
    expect(localStorage.getItem(scopedKey('contractoros_boq', 'PRJ-001'))).toBeNull();
    expect(localStorage.getItem('contractoros_entries')).toBeNull();

    localStorage.setItem(scopedKey('contractoros_boq', 'PRJ-001'), JSON.stringify([{ id: 'b-1' }]));

    setStorageNamespace(A);
    expect(JSON.parse(localStorage.getItem(scopedKey('contractoros_boq', 'PRJ-001'))!)).toEqual([{ id: 'a-1' }]);
    setStorageNamespace(B);
    expect(JSON.parse(localStorage.getItem(scopedKey('contractoros_boq', 'PRJ-001'))!)).toEqual([{ id: 'b-1' }]);
  });

  it('keeps the ledger apart, and a backup taken as one user excludes the other', () => {
    setStorageNamespace(A);
    saveEntry('expense-paid', { date: '2025-04-20', category: 'Office', amount: 500, method: 'cash' });

    setStorageNamespace(B);
    saveEntry('expense-paid', { date: '2025-04-20', category: 'Office', amount: 900, method: 'cash' });
    const snapshotB = backupSnapshot();
    expect(snapshotB).toContain('900');
    expect(snapshotB).not.toContain('500');

    setStorageNamespace(A);
    const snapshotA = backupSnapshot();
    expect(snapshotA).toContain('500');
    expect(snapshotA).not.toContain('900');
  });

  it('hides other accounts from key listing, which backups and exports walk', () => {
    setStorageNamespace(A);
    localStorage.setItem('contractoros_boq', '[]');
    localStorage.setItem('darkMode', 'true');

    setStorageNamespace(B);
    localStorage.setItem('contractoros_dsr', '[]');

    const listedB = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
    expect(listedB).toContain('contractoros_dsr');
    expect(listedB).not.toContain('contractoros_boq');
    expect(listedB).toContain('darkMode'); // a preference, not app data
  });

  it('clear() removes only the signed-in account’s data', () => {
    setStorageNamespace(A);
    localStorage.setItem('contractoros_boq', '[]');
    localStorage.setItem('contractoros_accounts', '[]');

    setStorageNamespace(B);
    localStorage.setItem('contractoros_dsr', '[]');
    localStorage.setItem('contractoros_auth_users', '[{"id":"x"}]');

    localStorage.clear(); // as B
    expect(localStorage.getItem('contractoros_dsr')).toBeNull();
    expect(localStorage.getItem('contractoros_auth_users')).not.toBeNull(); // credentials survive
    expect(localStorage.getItem('contractoros_boq')).toBeNull(); // A's data is not visible as B

    setStorageNamespace(A);
    expect(localStorage.getItem('contractoros_boq')).toBe('[]'); // and A is untouched by B's clear
  });
});

describe('94. adopting data from before accounts existed', () => {
  it('gives legacy data to the first account only, once', () => {
    setStorageNamespace(null);
    localStorage.setItem('contractoros_boq', '[{"id":"legacy"}]');
    localStorage.setItem('contractoros_entries', '[{"id":"legacy-entry"}]');
    expect(legacyAppKeys().length).toBe(2);

    const first = adoptLegacyData(A);
    expect(first.adopted).toBe(2);
    expect(legacyOwner()).toBe(A);

    setStorageNamespace(A);
    expect(JSON.parse(localStorage.getItem('contractoros_boq')!)).toEqual([{ id: 'legacy' }]);

    const second = adoptLegacyData(B);
    expect(second.alreadyOwned).toBe(true);
    expect(second.adopted).toBe(0);

    setStorageNamespace(B);
    expect(localStorage.getItem('contractoros_boq')).toBeNull(); // B starts empty
  });

  it('purges one account without touching the other', () => {
    setStorageNamespace(A);
    localStorage.setItem('contractoros_boq', '["a"]');
    setStorageNamespace(B);
    localStorage.setItem('contractoros_boq', '["b"]');

    expect(userKeys(A).length).toBe(1);
    expect(usersWithData().map((u) => u.userId).sort()).toEqual([A, B]);

    purgeUserData(A);
    expect(userKeys(A).length).toBe(0);
    setStorageNamespace(B);
    expect(localStorage.getItem('contractoros_boq')).toBe('["b"]');
  });
});
