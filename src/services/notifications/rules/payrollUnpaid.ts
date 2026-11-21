import type { NotificationCandidate, NotificationRule } from '../types';
import { daysBetween, money, notificationKey, plural } from './helpers';

/** An approved payroll run that has not been paid after three days. */
export const payrollUnpaidRule: NotificationRule = {
  id: 'payroll-unpaid',
  kind: 'payroll',
  label: 'Approved payroll unpaid',
  description: 'A payroll run was approved three or more days ago and is still unpaid.',
  defaultEnabled: true,
  evaluate(ctx): NotificationCandidate[] {
    const out: NotificationCandidate[] = [];
    for (const run of ctx.payrollRuns) {
      if (run.status !== 'approved' || run.paid_at) continue;
      const anchor = String(run.approved_at || run.created_at || '').slice(0, 10);
      const age = daysBetween(anchor, ctx.todayAD);
      if (age === null || age < 3) continue;
      const label = `${run.bs_year}-${String(run.bs_month).padStart(2, '0')}`;
      out.push({
        dedupeKey: notificationKey('payroll-unpaid', ctx.projectId, run.id),
        kind: 'payroll',
        severity: 'warning',
        title: `Payroll ${label} is approved but unpaid`,
        body: `${money(run.totals_json?.payable)} payable · approved ${plural(age, 'day')} ago. Pay it or reopen the run.`,
        action: { page: 'attendance', entityId: run.id },
        meta: { runId: run.id, month: label },
      });
    }
    return out;
  },
};
