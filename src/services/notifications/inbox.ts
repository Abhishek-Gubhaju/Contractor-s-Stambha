// The inbox: storage, normalization, pruning and the external store the UI
// subscribes to. Nothing here decides *what* to notify — rules do that.
import { readScoped, writeScoped } from '../projectScope';
import type { AppNotification, NotificationAction, NotificationKind, NotificationSeverity } from './types';
import { NOTIFICATION_KINDS } from './types';

export const NOTIFICATIONS_KEY = 'contractoros_notifications';
export const NOTIFICATION_STATE_KEY = 'contractoros_notification_state';
export const NOTIFICATIONS_CHANGED_EVENT = 'contractoros:notifications-changed';

const MAX_STORED = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const READ_KEEP_DAYS = 60;
const DISMISSED_KEEP_DAYS = 90;
const RESOLVED_KEEP_DAYS = 30;

export interface NotificationState {
  lastSync: number | null;
  /** When a critical item last raised a toast, so it never repeats. */
  toasted: Record<string, number>;
}

function isoOrNull(value: unknown): string | null {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function cleanText(value: unknown, max: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function isKind(value: unknown): value is NotificationKind {
  return NOTIFICATION_KINDS.includes(value as NotificationKind);
}

function isSeverity(value: unknown): value is NotificationSeverity {
  return value === 'info' || value === 'warning' || value === 'critical';
}

const NOTIFICATION_PAGES = new Set([
  'dashboard',
  'boq',
  'job-costing',
  'dsr',
  'attendance',
  'billing',
  'commitments',
  'inventory',
  'work-progress',
  'ledger',
  'financials',
  'gantt',
  'vault',
  'staff-info',
  'notifications',
  'settings',
]);

function cleanAction(value: unknown): NotificationAction {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  // A restored or hand-edited row must never send the app to a blank page.
  const requested = cleanText(input.page, 40);
  const page = NOTIFICATION_PAGES.has(requested) ? requested : 'dashboard';
  const entityId = cleanText(input.entityId, 140);
  return entityId ? { page, entityId } : { page };
}

function cleanMeta(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string' || typeof raw === 'number') out[key] = String(raw).slice(0, 200);
  }
  return out;
}

/** One stored row to a known-safe notification, or null when unusable. */
export function normalizeNotification(raw: unknown): AppNotification | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  const dedupeKey = cleanText(input.dedupeKey, 300) || cleanText(input.id, 300);
  const id = cleanText(input.id, 300) || dedupeKey;
  if (!id || !dedupeKey) return null;
  if (!isKind(input.kind)) return null;
  const createdAt = isoOrNull(input.createdAt);
  if (!createdAt) return null;
  const title = cleanText(input.title, 140);
  if (!title) return null;
  return {
    id,
    dedupeKey,
    kind: input.kind,
    severity: isSeverity(input.severity) ? input.severity : 'info',
    title,
    body: cleanText(input.body, 600),
    projectId: cleanText(input.projectId, 40),
    createdAt,
    readAt: isoOrNull(input.readAt),
    dismissedAt: isoOrNull(input.dismissedAt),
    snoozedUntil: isoOrNull(input.snoozedUntil),
    resolvedAt: isoOrNull(input.resolvedAt),
    action: cleanAction(input.action),
    meta: cleanMeta(input.meta),
  };
}

function ageDays(iso: string, now: number): number {
  return (now - Date.parse(iso)) / DAY_MS;
}

/** Drop expired bookkeeping and duplicates, newest first, hard cap 500. */
export function normalizeInbox(raw: unknown, now = Date.now()): AppNotification[] {
  const rows = Array.isArray(raw) ? raw : [];
  const byId = new Map<string, AppNotification>();
  for (const row of rows) {
    const notification = normalizeNotification(row);
    if (!notification) continue;
    const previous = byId.get(notification.id);
    if (!previous || Date.parse(notification.createdAt) > Date.parse(previous.createdAt)) {
      byId.set(notification.id, notification);
    }
  }
  const kept = [...byId.values()].filter((n) => {
    if (n.dismissedAt && ageDays(n.dismissedAt, now) > DISMISSED_KEEP_DAYS) return false;
    if (n.resolvedAt && ageDays(n.resolvedAt, now) > RESOLVED_KEEP_DAYS) return false;
    if (n.readAt && ageDays(n.readAt, now) > READ_KEEP_DAYS) return false;
    return true;
  });
  kept.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
  return kept.slice(0, MAX_STORED);
}

export function loadInbox(now = Date.now(), projectId?: string): AppNotification[] {
  return normalizeInbox(readScoped<unknown>(NOTIFICATIONS_KEY, [], projectId), now);
}

export function saveInbox(list: AppNotification[], projectId?: string): void {
  writeScoped(NOTIFICATIONS_KEY, normalizeInbox(list), projectId);
  invalidateNotifications();
}

export function loadNotificationState(): NotificationState {
  const raw = readScoped<Partial<NotificationState>>(NOTIFICATION_STATE_KEY, {});
  const toasted: Record<string, number> = {};
  if (raw && typeof raw.toasted === 'object' && raw.toasted) {
    for (const [key, value] of Object.entries(raw.toasted)) {
      if (typeof value === 'number' && Number.isFinite(value)) toasted[key] = value;
    }
  }
  return {
    lastSync: typeof raw?.lastSync === 'number' && Number.isFinite(raw.lastSync) ? raw.lastSync : null,
    toasted,
  };
}

export function saveNotificationState(state: NotificationState): void {
  writeScoped(NOTIFICATION_STATE_KEY, state);
}

/** Is this notification currently visible in the bell/list? */
export function isActiveNotification(n: AppNotification, now = Date.now()): boolean {
  if (n.dismissedAt || n.resolvedAt) return false;
  if (n.snoozedUntil && Date.parse(n.snoozedUntil) > now) return false;
  return true;
}

export function activeNotifications(list: AppNotification[], now = Date.now()): AppNotification[] {
  return list.filter((n) => isActiveNotification(n, now));
}

export function unreadCountOf(list: AppNotification[]): number {
  return list.filter((n) => !n.readAt).length;
}

// ---------------------------------------------------------------------------
// External store (useSyncExternalStore): one stable snapshot per change.
// ---------------------------------------------------------------------------
let snapshot: AppNotification[] | null = null;
const listeners = new Set<() => void>();

export function subscribeNotifications(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getNotificationsSnapshot(): AppNotification[] {
  if (snapshot === null) snapshot = loadInbox();
  return snapshot;
}

function invalidateNotifications(): void {
  snapshot = null;
}

/** Announce a change to React and to any other surface (bell/page). */
export function emitNotificationsChanged(): void {
  snapshot = null;
  listeners.forEach((listener) => listener());
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(NOTIFICATIONS_CHANGED_EVENT));
  }
}

/** Re-read storage (project switch, another window, restore). */
export function reloadNotifications(): void {
  emitNotificationsChanged();
}

/** Test hook: forget the memoised snapshot and subscribers. */
export function resetNotificationsForTests(): void {
  snapshot = null;
  listeners.clear();
}
