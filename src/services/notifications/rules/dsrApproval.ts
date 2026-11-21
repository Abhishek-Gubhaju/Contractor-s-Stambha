import type { NotificationCandidate, NotificationRule } from '../types';
import { daysBetween, notificationKey, plural } from './helpers';

/** A submitted report waiting for a supervisor's approval. */
export const dsrApprovalRule: NotificationRule = {
  id: 'dsr-approval',
  kind: 'dsr',
  label: 'DSR waiting for approval',
  description: 'A submitted site report left unapproved for more than a day.',
  defaultEnabled: true,
  evaluate(ctx): NotificationCandidate[] {
    const out: NotificationCandidate[] = [];
    for (const report of ctx.dsr) {
      if (report.status !== 'submitted') continue;
      const anchor = String(report.submittedAt || report.date || '').slice(0, 10);
      const age = daysBetween(anchor, ctx.todayAD);
      if (age === null || age < 1) continue;
      out.push({
        dedupeKey: notificationKey('dsr-approval', ctx.projectId, report.id),
        kind: 'dsr',
        severity: 'info',
        title: `DSR ${report.reportNo || report.date} awaiting approval`,
        body: `Submitted ${plural(age, 'day')} ago (${anchor}). Review it so billing is not held up.`,
        action: { page: 'dsr', entityId: report.id },
        meta: { date: report.date, reportNo: report.reportNo || '' },
      });
    }
    return out;
  },
};
