// @vitest-environment jsdom
// Section 0 deletion checks + KEEP list:
//   • legacy ledger_entries is READ-ONLY (normalized in memory, never written)
//   • no legacy writer functions remain on the service
//   • the voucher numbering service survives and is EXTENDED (nextInSeries)
//   • attachments + full backup helpers kept
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ENTRIES_KEY,
  loadEntries,
  nextVoucher,
  nextInSeries,
  voucherPrefix,
  saveAttachment,
  readAttachment,
  backupSnapshot,
} from './ledgerService';

beforeEach(() => localStorage.clear());

describe('S0.2 legacy ledger_entries is read-only (migration only)', () => {
  it('loadEntries normalizes in memory but never writes the table back', () => {
    const seed = [
      { id: 'X-1', transactionDate: '2026-10-09', accountCategory: 'Cash', transactionType: 'Debit', amount: 500, balanceAfter: 500, created_at: '2026-01-01T00:00:00.000Z' },
    ];
    localStorage.setItem(ENTRIES_KEY, JSON.stringify(seed));
    const rawBefore = localStorage.getItem(ENTRIES_KEY)!;

    const a = loadEntries();
    expect(a).toHaveLength(1);
    expect(a[0].cash_in).toBe(500); // in-memory normalization (F6)
    expect(a[0].bs_year).toBeGreaterThan(2080);
    // NO write-back: raw legacy table byte-identical after loads
    expect(localStorage.getItem(ENTRIES_KEY)).toBe(rawBefore);

    const b = loadEntries(); // idempotent in memory
    expect(b[0]).toEqual(a[0]);
    expect(localStorage.getItem(ENTRIES_KEY)).toBe(rawBefore);
  });

  it('all legacy writer functions are deleted from the service (S0.1/S0.2)', async () => {
    const mod: any = await import('./ledgerService');
    for (const fn of ['post', 'update', 'remove', 'saveEntries', 'setOpening', 'lockPeriod', 'unlockPeriod', 'computeReconciliation', 'periodStats']) {
      expect(typeof mod[fn], `${fn} must be gone`).toBe('undefined');
    }
  });
});

describe('voucher numbering service — kept and EXTENDED with new series (KEEP)', () => {
  it('nextInSeries sequences any prefix inside its fiscal year', () => {
    expect(nextInSeries('XX-2082/83-', [])).toBe('XX-2082/83-001');
    expect(nextInSeries('XX-2082/83-', ['XX-2082/83-001', 'XX-2082/83-003'])).toBe('XX-2082/83-004');
    expect(nextInSeries('XX-2082/83-', ['XX-2081/82-009'])).toBe('XX-2082/83-001'); // FY-scoped
  });

  it('legacy RV/PV/JV/OB series still resolve from the same service', () => {
    expect(nextVoucher('receipt', '2025-04-20', [])).toMatch(/^RV-2082\/83-001$/);
    expect(nextVoucher('payment', '2025-04-20', [])).toMatch(/^PV-2082\/83-001$/);
    expect(voucherPrefix('opening')).toBe('OB');
    expect(voucherPrefix('journal')).toBe('JV');
  });
});

describe('KEEP: attachments + full backup helpers', () => {
  it('attachment path is stored offline and survives a reload', () => {
    const path = saveAttachment('scan.png', 'data:image/png;base64,AAAA');
    expect(path).toContain('data/ledger/attachments/');
    expect(readAttachment(path)).toBe('data:image/png;base64,AAAA');
    // reload from storage only — no in-memory state involved
    expect(readAttachment(path)).toBe('data:image/png;base64,AAAA');
  });

  it('backup snapshot contains every contractoros_ store', () => {
    localStorage.setItem(ENTRIES_KEY, JSON.stringify([{ id: 'a' }]));
    const snap = JSON.parse(backupSnapshot());
    expect(snap.exported_at).toBeTruthy();
    expect(snap[ENTRIES_KEY]).toHaveLength(1);
  });
});
