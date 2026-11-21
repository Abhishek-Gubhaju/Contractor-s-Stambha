import type { NotificationCandidate, NotificationRule } from '../types';
import { addDaysIso, notificationKey } from './helpers';

/**
 * Yesterday has no report. A brand-new job is exempt until it has three
 * reports, so the very first day of work does not raise a false alarm.
 */
export const dsrMissingRule: NotificationRule = {
  id: 'dsr-missing',
  kind: 'dsr',
  label: 'Yesterday has no DSR',
  description: 'Once a job has three reports, a missing yesterday is flagged.',
  defaultEnabled: true,
  evaluate(ctx): NotificationCandidate[] {
    if (ctx.dsr.length < 3) return [];
    const yesterday = addDaysIso(ctx.todayAD, -1);
    if (!yesterday) return [];
    const filed = ctx.dsr.some((report) => String(report.date || '').slice(0, 10) === yesterday);
    if (filed) return [];
    return [
      {
        dedupeKey: notificationKey('dsr-missing', ctx.projectId, 'yesterday', yesterday),
        kind: 'dsr',
        severity: 'warning',
        title: `No DSR for ${yesterday}`,
        body: 'No site report was filed for yesterday. Add it before the work is forgotten.',
        action: { page: 'dsr' },
        meta: { date: yesterday },
      },
    ];
  },
};
