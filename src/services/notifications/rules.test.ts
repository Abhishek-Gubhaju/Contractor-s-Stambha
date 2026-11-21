import { describe, expect, it } from 'vitest';
import type { AppBOQSection, AppMilestone } from '../../types';
import type { DsrReport } from '../dsrService';
import type { PartyRow } from '../booksService';
import type { PayrollRun } from '../labourService';
import type { StaffAttendanceSummary } from '../staffAttendanceService';
import type { Activity } from '../dsrSyncService';
import type { NotificationContext } from './types';
import { defaultNotificationPrefs } from './prefs';
import { dsrDraftRule } from './rules/dsrDraft';
import { dsrApprovalRule } from './rules/dsrApproval';
import { dsrMissingRule } from './rules/dsrMissing';
import { boqOverrunRule } from './rules/boqOverrun';
import { boqNearlyRule } from './rules/boqNearly';
import { billDueRule } from './rules/billDue';
import { invoiceDueRule } from './rules/invoiceDue';
import { stockLowRule } from './rules/stockLow';
import { payrollUnpaidRule } from './rules/payrollUnpaid';
import { staffLeaveRule } from './rules/staffLeave';
import { scheduleLateRule } from './rules/scheduleLate';
import { backupStaleRule, backupDateOf } from './rules/backupStale';

const prefs = defaultNotificationPrefs();

function ctx(overrides: Partial<NotificationContext> = {}): NotificationContext {
  return {
    now: Date.parse('2026-11-20T06:00:00.000Z'),
    todayAD: '2026-11-20',
    timezone: 'Asia/Kathmandu',
    projectId: 'PRJ-001',
    dsr: [],
    boq: [],
    stock: [],
    payrollRuns: [],
    activities: [],
    milestones: [],
    staffLeave: [],
    loadParties: () => [],
    backup: { last: null, auto: null, desktop: true },
    ...overrides,
  };
}

function report(partial: Record<string, unknown> = {}): DsrReport {
  return {
    id: 'r1',
    reportNo: 'DSR-1',
    date: '2026-11-18',
    status: 'draft',
    submittedAt: '',
    approvedAt: '',
    items: [{ id: 'i1', boqCode: 'A', description: 'Slab', unit: 'm3', quantity: 2 }],
    attachments: [],
    labour: [],
    plant: [],
    materials: [],
    tests: [],
    delays: [],
    ...partial,
  } as unknown as DsrReport;
}

function boq(code: string, estimated: number, unit = 'm3'): AppBOQSection[] {
  return [
    {
      id: 's1',
      sectionCode: '1',
      description: 'Section',
      amount: 0,
      isSection: true,
      children: [
        {
          id: 'i1',
          sectionCode: '1',
          itemCode: code,
          description: 'Item',
          unit,
          estimatedQuantity: estimated,
          rate: 100,
          amount: 0,
          actualMaterialCost: 0,
          actualLaborCost: 0,
          completedQuantity: 0,
        },
      ],
    },
  ];
}

function party(overrides: Partial<PartyRow> = {}): PartyRow {
  return {
    party_id: 'Nepal Traders',
    receivable: 0,
    payable: 5000,
    aging: { b0_30: 0, b31_60: 0, b61: 0 },
    openBills: [],
    ...overrides,
  };
}

function activity(overrides: Partial<Activity> = {}): Activity {
  return {
    id: 'a1',
    code: 'A1',
    name: 'Slab pour',
    sector: '',
    start: '2026-11-01',
    end: '2026-11-15',
    progress: 40,
    status_cache: 'active',
    baseline_start: null,
    baseline_end: null,
    actual_start: null,
    actual_finish: null,
    forecast_finish: null,
    is_milestone: false,
    synced_at: null,
    ...overrides,
  };
}

describe('DSR rules', () => {
  it('flags a draft older than the grace period, but not a young or empty one', () => {
    const stale = dsrDraftRule.evaluate(ctx({ dsr: [report({ date: '2026-11-18' })] }), prefs);
    expect(stale).toHaveLength(1);
    expect(stale[0].severity).toBe('warning');
    expect(stale[0].action.page).toBe('dsr');

    expect(dsrDraftRule.evaluate(ctx({ dsr: [report({ date: '2026-11-19' })] }), prefs)).toHaveLength(0);
    expect(
      dsrDraftRule.evaluate(
        ctx({ dsr: [report({ date: '2026-11-01', items: [], attachments: [] })] }),
        prefs
      )
    ).toHaveLength(0);
  });

  it('flags a submitted report waiting more than a day for approval', () => {
    const out = dsrApprovalRule.evaluate(
      ctx({ dsr: [report({ status: 'submitted', submittedAt: '2026-11-18T09:00:00.000Z' })] }),
      prefs
    );
    expect(out).toHaveLength(1);
    expect(out[0].title).toMatch(/awaiting approval/i);
    expect(out[0].severity).toBe('info');
    expect(
      dsrApprovalRule.evaluate(
        ctx({ dsr: [report({ status: 'submitted', submittedAt: '2026-11-20T09:00:00.000Z' })] }),
        prefs
      )
    ).toHaveLength(0);
  });

  it('flags a missing yesterday only after three reports exist', () => {
    const three = [
      report({ id: 'a', date: '2026-11-16' }),
      report({ id: 'b', date: '2026-11-17' }),
      report({ id: 'c', date: '2026-11-18' }),
    ];
    const out = dsrMissingRule.evaluate(ctx({ dsr: three }), prefs);
    expect(out).toHaveLength(1);
    expect(out[0]?.meta?.date).toBe('2026-11-19');
    expect(dsrMissingRule.evaluate(ctx({ dsr: three.slice(0, 2) }), prefs)).toHaveLength(0);
    expect(
      dsrMissingRule.evaluate(ctx({ dsr: [...three, report({ id: 'd', date: '2026-11-19' })] }), prefs)
    ).toHaveLength(0);
  });
});

describe('BOQ rules', () => {
  it('flags work recorded above the BOQ estimate as critical', () => {
    const out = boqOverrunRule.evaluate(
      ctx({
        boq: boq('A', 10),
        dsr: [report({ items: [{ id: 'i1', boqCode: 'A', description: '', unit: 'm3', quantity: 12 }] })],
      }),
      prefs
    );
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('critical');
    expect(out[0].body).toContain('12');
    expect(out[0].body).toContain('10');
  });

  it('does not flag work exactly at the estimate or below it', () => {
    const at = report({ items: [{ id: 'i1', boqCode: 'A', description: '', unit: 'm3', quantity: 10 }] });
    expect(boqOverrunRule.evaluate(ctx({ boq: boq('A', 10), dsr: [at] }), prefs)).toHaveLength(0);
  });

  it('flags a code at 95–99% only when that rule is enabled', () => {
    const near = report({ items: [{ id: 'i1', boqCode: 'A', description: '', unit: 'm3', quantity: 9.6 }] });
    const out = boqNearlyRule.evaluate(ctx({ boq: boq('A', 10), dsr: [near] }), prefs);
    expect(out).toHaveLength(1);
    expect(out[0].title).toContain('96%');
    expect(boqNearlyRule.defaultEnabled).toBe(false);
  });
});

describe('money rules', () => {
  it('flags a supplier bill due soon and escalates a long-overdue one', () => {
    const soon = billDueRule.evaluate(
      ctx({
        loadParties: () => [
          party({
            openBills: [{ id: 'B-1', ad_date: '2026-10-01', due: '2026-11-23', outstanding: 5000, kind: 'bill' }],
          }),
        ],
      }),
      prefs
    );
    expect(soon).toHaveLength(1);
    expect(soon[0].severity).toBe('warning');
    expect(soon[0].action.page).toBe('ledger');

    const late = billDueRule.evaluate(
      ctx({
        loadParties: () => [
          party({
            openBills: [{ id: 'B-2', ad_date: '2026-08-01', due: '2026-09-01', outstanding: 900, kind: 'bill' }],
          }),
        ],
      }),
      prefs
    );
    expect(late[0]?.severity).toBe('critical');
  });

  it('ignores bills outside the lead time and client invoices in the bill rule', () => {
    const out = billDueRule.evaluate(
      ctx({
        loadParties: () => [
          party({
            openBills: [
              { id: 'B-3', ad_date: '2026-10-01', due: '2027-01-01', outstanding: 10, kind: 'bill' },
              { id: 'I-1', ad_date: '2026-10-01', due: '2026-11-21', outstanding: 10, kind: 'invoice' },
            ],
          }),
        ],
      }),
      prefs
    );
    expect(out).toHaveLength(0);
  });

  it('flags a client invoice due soon', () => {
    const out = invoiceDueRule.evaluate(
      ctx({
        loadParties: () => [
          party({
            openBills: [{ id: 'I-2', ad_date: '2026-10-01', due: '2026-11-21', outstanding: 12000, kind: 'invoice' }],
          }),
        ],
      }),
      prefs
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('invoice');
    expect(out[0].body).toContain('Nepal Traders');
  });

  it('flags stock at or below its reorder level, skipping items without one', () => {
    const item = { id: 'it1', name: 'Cement', unit: 'bag', costCode: '', reorderLevel: 10 };
    const out = stockLowRule.evaluate(
      ctx({ stock: [{ item, qty: 10, value: 0, avg: 0, shortfall: 0 }] }),
      prefs
    );
    expect(out).toHaveLength(1);
    expect(out[0].body).toContain('10 bag');

    expect(
      stockLowRule.evaluate(
        ctx({ stock: [{ item: { ...item, reorderLevel: 0 }, qty: 0, value: 0, avg: 0, shortfall: 0 }] }),
        prefs
      )
    ).toHaveLength(0);
    expect(
      stockLowRule.evaluate(ctx({ stock: [{ item, qty: 11, value: 0, avg: 0, shortfall: 0 }] }), prefs)
    ).toHaveLength(0);
  });

  it('flags an approved payroll run unpaid after three days', () => {
    const run = {
      id: 'RUN-1',
      bs_year: 2083,
      bs_month: 7,
      status: 'approved',
      totals_json: { payable: 25000 },
      paid_at: null,
      approved_at: '2026-11-16T00:00:00.000Z',
      created_at: '2026-11-15T00:00:00.000Z',
    } as unknown as PayrollRun;
    const out = payrollUnpaidRule.evaluate(ctx({ payrollRuns: [run] }), prefs);
    expect(out).toHaveLength(1);
    expect(out[0].body).toContain('25,000');
    expect(
      payrollUnpaidRule.evaluate(ctx({ payrollRuns: [{ ...run, paid_at: '2026-11-17' }] }), prefs)
    ).toHaveLength(0);
  });
});

describe('people and schedule rules', () => {
  it('flags staff over the monthly leave limit', () => {
    const row = {
      staff_id: 'S-1',
      code: 'E01',
      name: 'Asha Rai',
      department: 'Site',
      present: 10,
      absent: 0,
      leave: 6,
      salary: 40000,
      overLeaveLimit: true,
    } as StaffAttendanceSummary;
    const out = staffLeaveRule.evaluate(ctx({ staffLeave: [row] }), prefs);
    expect(out).toHaveLength(1);
    expect(out[0].body).toContain('6 leave days');
    expect(out[0].action.page).toBe('staff-info');
  });

  it('flags late activities and escalates a late milestone', () => {
    const out = scheduleLateRule.evaluate(
      ctx({
        activities: [activity(), activity({ id: 'done', status_cache: 'done' })],
        milestones: [
          {
            id: 'm1',
            name: 'Structure',
            endDate: '2026-11-10',
            status: 'delayed',
            targetQuantity: 10,
            actualQuantity: 3,
          } as unknown as AppMilestone,
        ],
      }),
      prefs
    );
    expect(out).toHaveLength(2);
    expect(out.some((n) => n.severity === 'critical')).toBe(true);
    expect(out.some((n) => n.action.page === 'work-progress')).toBe(true);
    expect(out.some((n) => n.action.page === 'gantt')).toBe(true);
  });

  it('does not flag a completed milestone whose target quantity is met', () => {
    const out = scheduleLateRule.evaluate(
      ctx({
        milestones: [
          {
            id: 'm2',
            name: 'Roof',
            endDate: '2026-11-10',
            status: 'completed',
            targetQuantity: 10,
            actualQuantity: 10,
          } as unknown as AppMilestone,
        ],
      }),
      prefs
    );
    expect(out).toHaveLength(0);
  });
});

describe('backup rule', () => {
  it('reads the date out of a run id', () => {
    expect(backupDateOf('20261120093000')).toBe('2026-11-20');
    expect(backupDateOf('2026-11-20-0930')).toBe('2026-11-20');
    expect(backupDateOf('not-a-run')).toBeNull();
  });

  it('asks for a first backup, then warns only when it is stale', () => {
    const first = backupStaleRule.evaluate(ctx(), prefs);
    expect(first).toHaveLength(1);
    expect(first[0]?.meta?.state).toBe('never');

    const stale = backupStaleRule.evaluate(
      ctx({
        backup: {
          last: { mode: 'desktop', runId: '20261001-0900', fileCount: 3, bytes: 100, location: '/b' },
          auto: null,
          desktop: true,
        },
      }),
      prefs
    );
    expect(stale).toHaveLength(1);
    expect(stale[0]?.title).toMatch(/50 days/);

    const fresh = backupStaleRule.evaluate(
      ctx({
        backup: {
          last: { mode: 'desktop', runId: '20261119-0900', fileCount: 3, bytes: 100, location: '/b' },
          auto: null,
          desktop: true,
        },
      }),
      prefs
    );
    expect(fresh).toHaveLength(0);
  });
});
