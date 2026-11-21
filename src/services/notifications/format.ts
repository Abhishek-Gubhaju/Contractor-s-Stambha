// Presentation helpers shared by the bell and the page.
import type { NotificationKind, NotificationSeverity } from './types';

export const SEVERITY_LABEL: Record<NotificationSeverity, string> = {
  info: 'Information',
  warning: 'Warning',
  critical: 'Critical',
};

export const SEVERITY_DOT: Record<NotificationSeverity, string> = {
  info: 'bg-sky-500',
  warning: 'bg-amber-500',
  critical: 'bg-rose-500',
};

export const SEVERITY_PILL: Record<NotificationSeverity, string> = {
  info: 'bg-sky-50 text-sky-700 border-sky-200',
  warning: 'bg-amber-50 text-amber-800 border-amber-200',
  critical: 'bg-rose-50 text-rose-700 border-rose-200',
};

export const KIND_LABEL: Record<NotificationKind, string> = {
  dsr: 'Daily Site Report',
  boq: 'BOQ',
  bill: 'Supplier bill',
  invoice: 'Client invoice',
  stock: 'Inventory',
  payroll: 'Payroll',
  staff: 'Staff',
  schedule: 'Schedule',
  backup: 'Backup',
  vault: 'File Vault',
};

/** Machine-level reminders (backups) are not a job. */
export function projectLabel(projectId: string): string {
  if (!projectId || projectId === 'machine') return 'All jobs';
  return projectId;
}

/** Short, locale-free relative time: "just now", "7m ago", "3d ago". */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = now - t;
  if (diff < 60_000) return 'just now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(t).toLocaleDateString();
}

/** Date heading used by the page's day groups. */
export function dayLabel(iso: string, now = Date.now()): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const today = new Date(now);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(date, today)) return 'Today';
  const yesterday = new Date(now - 86_400_000);
  if (sameDay(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
