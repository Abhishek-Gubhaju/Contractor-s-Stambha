import type { NotificationCandidate, NotificationRule } from '../types';
import { daysBetween, notificationKey, plural } from './helpers';

/** A draft with recorded site work that has sat unsubmitted past the grace. */
export const dsrDraftRule: NotificationRule = {
  id: 'dsr-draft',
  kind: 'dsr',
  label: 'DSR drafts left open',
  description: 'A draft with recorded work that is older than the grace period.',
  defaultEnabled: true,
  evaluate(ctx, prefs): NotificationCandidate[] {
    const out: NotificationCandidate[] = [];
    for (const report of ctx.dsr) {
      if (report.status !== 'draft') continue;
      const hasWork =
        (report.items || []).some((item) => item && (item.boqCode || item.description || Number(item.quantity) > 0)) ||
        (report.attachments || []).length > 0;
      if (!hasWork) continue;
      const age = daysBetween(report.date, ctx.todayAD);
      if (age === null || age < prefs.dsrStaleDays) continue;
      out.push({
        dedupeKey: notificationKey('dsr-draft', ctx.projectId, report.id),
        kind: 'dsr',
        severity: 'warning',
        title: `DSR ${report.reportNo || report.date} is still a draft`,
        body: `${plural(age, 'day')} old (${report.date}). Submit it when the site sheet is complete.`,
        action: { page: 'dsr', entityId: report.id },
        meta: { date: report.date, reportNo: report.reportNo || '' },
      });
    }
    return out;
  },
};
