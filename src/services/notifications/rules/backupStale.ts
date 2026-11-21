import type { NotificationCandidate, NotificationRule } from '../types';
import { daysBetween, notificationKey, plural } from './helpers';

/** Run ids begin with YYYYMMDD; tolerate older ids that contain separators. */
export function backupDateOf(runId: string): string | null {
  const digits = String(runId || '')
    .replace(/\D/g, '')
    .slice(0, 8);
  if (digits.length !== 8) return null;
  const iso = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  const parsed = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10) === iso ? iso : null;
}

/** No backup, or the last one is older than the configured limit. */
export const backupStaleRule: NotificationRule = {
  id: 'backup-stale',
  kind: 'backup',
  label: 'Backups are stale',
  description: 'No backup has been taken, or the last one is older than the limit.',
  defaultEnabled: true,
  evaluate(ctx, prefs): NotificationCandidate[] {
    const last = ctx.backup.last;
    if (!last) {
      return [
        {
          dedupeKey: notificationKey('backup-stale', 'machine', 'none'),
          kind: 'backup',
          severity: 'warning',
          title: 'No backup yet',
          body: ctx.backup.desktop
            ? 'Take the first backup from Settings so this job can be restored.'
            : 'Download a backup from Settings so this job can be restored.',
          action: { page: 'settings' },
          meta: { state: 'never' },
        },
      ];
    }
    const date = backupDateOf(last.runId);
    if (!date) return [];
    const age = daysBetween(date, ctx.todayAD);
    if (age === null || age <= prefs.backupStaleDays) return [];
    return [
      {
        dedupeKey: notificationKey('backup-stale', 'machine', last.runId || date),
        kind: 'backup',
        severity: 'warning',
        title: `Last backup is ${plural(age, 'day')} old`,
        body: `The most recent backup is ${date}. Take a fresh one from Settings.`,
        action: { page: 'settings' },
        meta: { state: 'stale', date, age: String(age) },
      },
    ];
  },
};
