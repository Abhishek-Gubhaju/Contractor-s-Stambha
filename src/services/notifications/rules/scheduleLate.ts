import type { NotificationCandidate, NotificationRule } from '../types';
import { daysBetween, notificationKey, plural } from './helpers';

/** Gantt activities and milestones whose planned finish has passed unfinished. */
export const scheduleLateRule: NotificationRule = {
  id: 'schedule-late',
  kind: 'schedule',
  label: 'Late activities & milestones',
  description: 'A planned finish date has passed and the work is not complete.',
  defaultEnabled: true,
  evaluate(ctx): NotificationCandidate[] {
    const out: NotificationCandidate[] = [];

    for (const activity of ctx.activities) {
      if (activity.is_milestone) continue;
      if (activity.status_cache === 'done' || Number(activity.progress) >= 100) continue;
      const days = daysBetween(activity.end, ctx.todayAD);
      if (days === null || days <= 0) continue;
      const name = activity.name || activity.code || 'Activity';
      out.push({
        dedupeKey: notificationKey('schedule-late', ctx.projectId, `activity:${activity.id}`, activity.end || ''),
        kind: 'schedule',
        severity: 'warning',
        title: `${name} is ${plural(days, 'day')} late`,
        body: `Planned finish ${activity.end} · ${Math.min(100, Math.round(Number(activity.progress) || 0))}% complete.`,
        action: { page: 'gantt', entityId: activity.id },
        meta: { kind: 'activity', id: activity.id, end: activity.end || '' },
      });
    }

    for (const milestone of ctx.milestones) {
      if (milestone.status === 'completed') continue;
      const target = Number(milestone.targetQuantity) || 0;
      const actual = Number(milestone.actualQuantity) || 0;
      if (target > 0 && actual >= target) continue;
      const days = daysBetween(milestone.endDate, ctx.todayAD);
      if (days === null || days <= 0) continue;
      out.push({
        dedupeKey: notificationKey(
          'schedule-late',
          ctx.projectId,
          `milestone:${milestone.id}`,
          milestone.endDate
        ),
        kind: 'schedule',
        severity: 'critical',
        title: `${milestone.name} milestone is ${plural(days, 'day')} late`,
        body: `Target ${milestone.endDate} · ${milestone.status}. Check the plan or re-baseline it.`,
        action: { page: 'work-progress', entityId: milestone.id },
        meta: { kind: 'milestone', id: milestone.id, end: milestone.endDate },
      });
    }

    return out;
  },
};
