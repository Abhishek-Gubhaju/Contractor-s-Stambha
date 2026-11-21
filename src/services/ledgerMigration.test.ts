// @vitest-environment jsdom
// Acceptance check 77 — migration parity report green on seeded legacy data
// (S1: backup → convert → parity gate → idempotent; legacy table read-only).
import { describe, it, expect, beforeEach } from 'vitest';
import {
  runMigration,
  parityReport,
  migrationStatus,
  legacyBackupSnapshot,
  LEGACY_BACKUP_KEY,
} from './ledgerMigration';
import { ENTRIES_KEY as LEGACY_KEY } from './ledgerService';
import { allEntries, allLines, linesOf } from './booksService';
import { periodAdRange } from './periods';
import { keyFor } from './projectScope';

const R1 = periodAdRange({ year: 2082, month: 1 }); // Baisakh 2082
const R2 = periodAdRange({ year: 2082, month: 2 }); // Jestha 2082
const shift = (iso: string, days: number) => new Date(Date.parse(iso) + days * 86400000).toISOString().slice(0, 10);

/** Mixed-shape legacy seed: old schema, Section E rows, OB row, journal. */
function seedLegacy() {
  const rows = [
    // old schema — opening (cash in 2000)
    { id: 'OB-82-1', accountCategory: 'Opening Balance', transactionType: 'Opening', amount: 2000, transactionDate: R1.from, comment: 'Opening', balanceAfter: 2000 },
    // old schema — Debit on Materials → legacy treats it as cash-in (method cash)
    { id: 'CASH-1', codeOrName: 'Nepal Traders', accountCategory: 'Materials', transactionType: 'Debit', amount: 800, transactionDate: shift(R1.from, 5), balanceAfter: 0 },
    // Section E — bank receipt with attachment + billing source
    {
      id: 'RV-2082/83-001', voucher: 'RV-2082/83-001', ad_date: shift(R1.from, 10),
      bs_year: 2082, bs_month: 1, bs_day: 11, type: 'receipt', counterparty: 'Gyan Constructions',
      category: 'Client Receipt', method: 'bank', cash_in: 5000, cash_out: 0, expense: 0,
      source: 'billing', ref_id: 'B-1', attachment_path: 'data/ledger/attachments/x.png', note: 'milestone',
      created_at: '2025-04-24T00:00:00.000Z', edited_history: [],
    },
    // Section E — cash payment in period 2
    {
      id: 'PV-2082/83-001', voucher: 'PV-2082/83-001', ad_date: R2.from,
      bs_year: 2082, bs_month: 2, bs_day: 1, type: 'payment', counterparty: 'Sample Steel',
      category: 'Materials', method: 'cash', cash_in: 0, cash_out: 1500, expense: 1500,
      source: 'labour-advance', ref_id: 'w1', attachment_path: '', note: '', created_at: '', edited_history: [],
    },
    // Section E — journal: no cash leg at all
    {
      id: 'JV-2082/83-001', voucher: 'JV-2082/83-001', ad_date: shift(R2.from, 3),
      bs_year: 2082, bs_month: 2, bs_day: 4, type: 'journal', counterparty: '',
      category: 'Rent', method: 'journal', cash_in: 0, cash_out: 0, expense: 300,
      source: 'manual', ref_id: '', attachment_path: '', note: 'rent accrual', created_at: '', edited_history: [],
    },
  ];
  localStorage.setItem(LEGACY_KEY, JSON.stringify(rows));
  localStorage.setItem('contractoros_ledger_meta', JSON.stringify({ openings: { '2082-02': { cash: 1000 } }, locks: {}, audit: [] }));
}

beforeEach(() => localStorage.clear());

describe('77. migration parity report is green on seeded legacy data', () => {
  it('migrates once: backup first, counts reconciled, ΣDr = ΣCr, closings match per period', () => {
    seedLegacy();
    const rawBefore = localStorage.getItem(LEGACY_KEY)!;

    const res = runMigration();
    expect(res.error).toBeUndefined();
    expect(res.ran).toBe(true);
    expect(res.green).toBe(true);
    expect(res.migrated).toBe(5); // 5 legacy rows → 5 entries

    // S0.2: the legacy table is untouched (read-only, migration only)
    expect(localStorage.getItem(LEGACY_KEY)).toBe(rawBefore);

    // S1.1: full backup of the legacy tables persisted before conversion
    // The legacy snapshot is written under the active job's scope.
    const backup = JSON.parse(localStorage.getItem(keyFor(LEGACY_BACKUP_KEY))!);
    expect(backup.contractoros_ledger_entries).toHaveLength(5);
    expect(backup).toHaveProperty('contractoros_ledger_meta');

    const report = parityReport();
    expect(report.green).toBe(true);
    expect(report.balanced).toBe(true);
    expect(report.totalDebits).toBe(report.totalCredits);
    expect(report.countsMatch).toBe(true);
    expect(report.totalLegacyRows).toBe(5);
    expect(report.totalMigratedEntries).toBe(5);
    expect(report.periods.length).toBeGreaterThanOrEqual(2);
    for (const p of report.periods) {
      expect(p.green, `period ${p.period}`).toBe(true);
      expect(p.newCash.cash, `cash closing ${p.period}`).toBeCloseTo(p.legacyCash.cash, 2);
      expect(p.newCash.bank, `bank closing ${p.period}`).toBeCloseTo(p.legacyCash.bank, 2);
      expect(p.legacyRows).toBe(p.migratedEntries);
      expect(p.debits).toBe(p.credits);
    }
    expect(migrationStatus()).toEqual({ migrated: true, green: true, rows: 5 });

    // S1.2: inferred types + preserved fields
    const rv = allEntries().find((e) => e.id === 'RV-2082/83-001')!;
    expect(rv.type).toBe('receipt'); // cash leg → receipt
    expect(rv.source).toBe('billing'); // source badge preserved
    expect(rv.attachment).toBe('data/ledger/attachments/x.png'); // attachment path
    expect(rv.bs_y).toBe(2082); // local-calendar integers preserved
    expect(rv.bs_m).toBe(1);
    const rvLines = linesOf(rv.id);
    expect(rvLines.find((l) => l.account_id === 'acc:bank')?.debit).toBe(5000); // method → bank
    expect(rvLines.find((l) => l.account_id === 'acc:income')?.credit).toBe(5000); // category → account

    const pv = allEntries().find((e) => e.id === 'PV-2082/83-001')!;
    expect(pv.type).toBe('payment'); // cash out → payment
    expect(pv.source).toBe('payroll'); // labour-advance badge → payroll (read-only)

    const ob = allEntries().find((e) => e.id === 'OB-82-1')!;
    expect(ob.type).toBe('receipt');
    expect(linesOf(ob.id).find((l) => l.account_id === 'acc:opening')).toBeTruthy(); // opening equity

    const jv = allEntries().find((e) => e.id === 'JV-2082/83-001')!;
    expect(jv.type).toBe('journal');
    expect(linesOf(jv.id).every((l) => !['acc:cash', 'acc:bank'].includes(l.account_id))).toBe(true);

    // meta openings became entries too (so both sides count them once)
    expect(allEntries().some((e) => e.id.startsWith('OB-META-'))).toBe(true);

    // global books trial balance green after migration
    const total = allLines().reduce((s, l) => ({ d: s.d + l.debit, c: s.c + l.credit }), { d: 0, c: 0 });
    expect(Math.round(total.d * 100)).toBe(Math.round(total.c * 100));
  });

  it('is idempotent: a second run skips and never duplicates', () => {
    seedLegacy();
    const first = runMigration();
    expect(first.ran).toBe(true);
    const count = allEntries().length;
    const lines = allLines().length;

    const second = runMigration();
    expect(second.skipped).toBe(true);
    expect(second.ran).toBe(false);
    expect(allEntries()).toHaveLength(count);
    expect(allLines()).toHaveLength(lines);
    expect(parityReport().green).toBe(true);
  });

  it('empty legacy table migrates to a green trivial parity', () => {
    const res = runMigration();
    expect(res.ran).toBe(true);
    expect(res.green).toBe(true);
    expect(parityReport().green).toBe(true);
    expect(legacyBackupSnapshot().contractoros_ledger_entries).toHaveLength(0);
  });
});
