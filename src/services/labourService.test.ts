// @vitest-environment jsdom
// Acceptance checks G2/G3/G5 + 74 (payroll half): approve → pay creates
// exactly 2 auto-entries (accrual + payment) with correct splits.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadWorkers,
  saveWorkerRate,
  postAdvance,
  postNonCashTx,
  createDraftRun,
  approveRun,
  payRun,
  lockRun,
  computeRunTotals,
  workerStatement,
  reconcile,
  alerts,
  loadRuns,
} from './labourService';
import { allEntries, linesOf, saveEntry } from './booksService';
import { periodAdRange } from './periods';

const P = { year: 2082, month: 1 }; // Baisakh 2082
const RANGE = periodAdRange(P);
const day = (n: number) => new Date(Date.parse(RANGE.from) + n * 86400000).toISOString().slice(0, 10);

function seedWorkers() {
  localStorage.setItem(
    'contractoros_labor',
    JSON.stringify([
      { id: 'w1', name: 'Rajesh Kumar', trade: 'Mason', dailyWage: 1000, status: 'present' },
      { id: 'w2', name: 'Suresh Patel', trade: 'Carpenter', dailyWage: 1500, status: 'present' },
      { id: 'w3', name: 'Mohammed Ali', trade: 'Steel Fixer', dailyWage: 800, status: 'present' },
    ])
  );
  saveWorkerRate('w2', { payment_method: 'bank' }); // → two payment methods exist
}

/** 10 present days for w1 (6 on PRJ-001, 4 on PRJ-002); 5 days for w2 on PRJ-001. */
function seedAttendance() {
  const store: Record<string, any> = {};
  for (let i = 0; i < 10; i++) {
    store[day(i)] = {
      project_id: i < 6 ? 'PRJ-001' : 'PRJ-002',
      rows: [{ workerId: 'w1', status: 'present', hoursWorked: 8, overtimeHours: 0 }],
    };
  }
  for (let i = 0; i < 5; i++) {
    store[day(11 + i)] = {
      project_id: 'PRJ-001',
      rows: [{ workerId: 'w2', status: 'present', hoursWorked: 8, overtimeHours: 0 }],
    };
  }
  localStorage.setItem('contractoros_attendance', JSON.stringify(store));
}

beforeEach(() => {
  localStorage.clear();
  seedWorkers();
  seedAttendance();
});

describe('C3. earnings computed from attendance only', () => {
  it('daily rate × days with project split; workers resolved from labour + rate overrides', () => {
    const workers = loadWorkers();
    const w1 = workers.find((w) => w.id === 'w1')!;
    expect(w1.rate_type).toBe('daily');
    expect(w1.rate).toBe(1000);
    const w2 = workers.find((w) => w.id === 'w2')!;
    expect(w2.payment_method).toBe('bank');

    const totals = computeRunTotals(P);
    const n1 = totals.perWorker.find((w) => w.worker_id === 'w1')!;
    const n2 = totals.perWorker.find((w) => w.worker_id === 'w2')!;
    expect(n1.earned).toBe(10000); // 10 days × 1000
    expect(n1.byProject).toEqual({ 'PRJ-001': 6000, 'PRJ-002': 4000 });
    expect(n2.earned).toBe(7500); // 5 days × 1500
    expect(totals.earned).toBe(17500);
  });
});

describe('74. approve → pay creates exactly 2 auto-entries with correct splits (S5.1)', () => {
  function runFullFlow() {
    postAdvance({ worker_id: 'w1', date: day(1), amount: 2000 });
    postAdvance({ worker_id: 'w2', date: day(2), amount: 500 });
    postNonCashTx({ worker_id: 'w1', date: day(3), type: 'deduction', amount: 500 });
    const draft = createDraftRun(P);
    expect(draft.status).toBe('draft');
    approveRun(draft.id);
    return payRun(draft.id);
  }

  it('exactly 2 auto-entries (payroll-accrual + payroll-payment), correct sums and splits', () => {
    const paid = runFullFlow();
    expect(paid.status).toBe('paid');

    const totals = paid.totals_json;
    expect(totals.earned).toBe(17500);
    expect(totals.advances).toBe(2500);
    expect(totals.deductions).toBe(500);
    expect(totals.byMethod).toEqual({ cash: 7500, bank: 7000 });

    // exactly 2 auto-entries, both read-only payroll source, keyed to the run
    const auto = allEntries().filter((e) => e.ref === paid.id && e.source === 'payroll');
    expect(auto).toHaveLength(2);
    const accrual = auto.find((e) => e.type === 'payroll-accrual')!;
    const payment = auto.find((e) => e.type === 'payroll-payment')!;
    expect(accrual).toBeTruthy();
    expect(payment).toBeTruthy();
    expect(paid.posted_vouchers).toEqual([accrual.id, payment.id]);

    // accrual: Dr labour expense per project split · Cr worker balances
    const accrualLines = linesOf(accrual.id);
    const byProject: Record<string, number> = {};
    accrualLines.forEach((l) => {
      if (l.debit > 0) byProject[l.project_id] = Math.round(((byProject[l.project_id] || 0) + l.debit) * 100) / 100;
    });
    expect(byProject['PRJ-001']).toBe(11500); // w1 4500 + w2 7000
    expect(byProject['PRJ-002']).toBe(3000); // w1 3000
    expect(Object.values(byProject).reduce((s, v) => s + v, 0)).toBe(14500); // = earned − advances − deductions
    const workerCredits = accrualLines.filter((l) => l.credit > 0);
    expect(workerCredits.reduce((s, l) => s + l.credit, 0)).toBe(14500);
    expect(workerCredits.every((l) => l.account_id.startsWith('acc:worker:'))).toBe(true);

    // payment: Dr worker balances · Cr cash/bank per method
    const paymentLines = linesOf(payment.id);
    expect(paymentLines.filter((l) => l.debit > 0).reduce((s, l) => s + l.debit, 0)).toBe(14500);
    expect(paymentLines.filter((l) => l.account_id === 'acc:cash').reduce((s, l) => s + l.credit, 0)).toBe(totals.byMethod.cash);
    expect(paymentLines.filter((l) => l.account_id === 'acc:bank').reduce((s, l) => s + l.credit, 0)).toBe(totals.byMethod.bank);
    expect(paymentLines.filter((l) => l.credit > 0).reduce((s, l) => s + l.credit, 0)).toBe(14500);
  });

  it('workflow gates: draft→approved→paid→locked, wrong transitions rejected', () => {
    const draft = createDraftRun(P);
    expect(() => payRun(draft.id)).toThrow(/approved/i);
    approveRun(draft.id);
    expect(() => approveRun(draft.id)).toThrow(/draft/i);
    const paid = payRun(draft.id);
    expect(() => payRun(draft.id)).toThrow(/approved/i);
    const locked = lockRun(paid.id);
    expect(locked.status).toBe('locked');
    expect(() => lockRun(draft.id)).toThrow(/paid/i);
    expect(loadRuns()).toHaveLength(1);
  });
});

describe('G3. reconciliation amber before Pay, green after', () => {
  it('advances post immediately; pending run keeps it amber; after Pay both sides match → green', () => {
    postAdvance({ worker_id: 'w1', date: day(1), amount: 2000 });
    postAdvance({ worker_id: 'w2', date: day(2), amount: 500 });

    const before = reconcile(); // run not created yet
    expect(before.status).toBe('green'); // matched, nothing pending
    expect(before.ledgerOut).toBe(2500);
    expect(before.labourSide).toBe(2500); // advances already posted to ledger

    const draft = createDraftRun(P);
    expect(reconcile().status).toBe('amber'); // pending run → amber
    approveRun(draft.id);
    expect(reconcile().status).toBe('amber'); // still pending payment

    const paid = payRun(draft.id);
    const after = reconcile();
    expect(after.status).toBe('green'); // matched and nothing pending
    expect(after.difference).toBe(0);
    // no deduction in this scenario → payable = 17500 − 2500 = 15000
    expect(after.ledgerOut).toBe(2500 + paid.totals_json.payable); // advances + payroll cash out
    expect(after.labourSide).toBe(2500 + paid.totals_json.payable); // Σ advances + Σ payroll posted
  });

  it('turns red with the difference when books and labour sides diverge', () => {
    // a books-side worker advance that never reached the labour statements
    saveEntry('worker-advance', {
      date: RANGE.from,
      amount: 999,
      worker_id: 'ghost-worker',
      worker_name: 'Ghost',
      method: 'cash',
    });
    const rec = reconcile();
    expect(rec.status).toBe('red');
    expect(rec.difference).toBe(999);
  });
});

describe('G5. worker statements settle to zero after Pay except over-advanced carry-forwards', () => {
  it('paid workers hit zero; over-advanced worker keeps a negative carry-forward (red)', () => {
    postAdvance({ worker_id: 'w1', date: day(1), amount: 2000 });
    postAdvance({ worker_id: 'w2', date: day(2), amount: 500 });
    postNonCashTx({ worker_id: 'w1', date: day(3), type: 'deduction', amount: 500 });
    // w3 is over-advanced: cash out with no attendance earnings in the period
    postAdvance({ worker_id: 'w3', date: day(4), amount: 1000 });

    const draft = createDraftRun(P);
    // over-advanced worker is excluded from payment (payable = 0, carry negative)
    const w3 = draft.totals_json.perWorker.find((w) => w.worker_id === 'w3')!;
    expect(w3.net).toBe(-1000);
    expect(w3.payable).toBe(0);
    expect(w3.carry).toBe(-1000);

    approveRun(draft.id);
    const paid = payRun(draft.id);
    // only the two solvent workers were paid
    expect(paid.totals_json.payable).toBe(14500);

    expect(workerStatement('w1').balance).toBe(0); // 10000 − 2000 − 500 − 7500
    expect(workerStatement('w2').balance).toBe(0); // 7500 − 500 − 7000
    const st3 = workerStatement('w3');
    expect(st3.balance).toBe(-1000); // over-advanced carry-forward
    expect(st3.balance).toBeLessThan(0);

    // C8: over-advanced alert fires
    expect(alerts(P).some((a) => a.kind === 'over-advanced' && a.worker_id === 'w3')).toBe(true);
    // reconciliation still green: advances 3500 + payroll 14500 == ledger Labour out 18000
    expect(reconcile().status).toBe('green');
  });

  it('statement shows opening, earning rows with project split, advances, deductions, payments', () => {
    postAdvance({ worker_id: 'w1', date: day(1), amount: 2000 });
    postNonCashTx({ worker_id: 'w1', date: day(3), type: 'deduction', amount: 500 });
    const draft = createDraftRun(P);
    approveRun(draft.id);
    payRun(draft.id);
    const st = workerStatement('w1');
    expect(st.opening).toBe(0);
    expect(st.earned).toBe(10000);
    expect(st.advances).toBe(2000);
    expect(st.deductions).toBe(500);
    expect(st.payments).toBe(7500);
    expect(st.balance).toBe(0);
    const earningProjects = new Set(st.rows.filter((r) => r.kind === 'earning').map((r) => r.project_id));
    expect(earningProjects.has('PRJ-001')).toBe(true);
    expect(earningProjects.has('PRJ-002')).toBe(true);
    expect(st.rows.some((r) => r.kind === 'advance')).toBe(true);
    expect(st.rows.some((r) => r.kind === 'payment')).toBe(true);
  });
});
