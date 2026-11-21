// Sync: run enabled rules once, merge candidates into the inbox, and expose
// the read/dismiss/snooze actions. This module owns every mutation so the UI
// never writes the inbox directly.
import { notify } from '../../components/ui/DialogHost';
import { buildNotificationContext } from './context';
import { loadPrefs } from './prefs';
import {
  activeNotifications,
  emitNotificationsChanged,
  isActiveNotification,
  loadInbox,
  loadNotificationState,
  normalizeInbox,
  reloadNotifications,
  saveInbox,
  saveNotificationState,
  unreadCountOf,
} from './inbox';
import { NOTIFICATION_RULES } from './rules';
import type {
  AppNotification,
  NotificationCandidate,
  NotificationContext,
  NotificationPrefs,
  NotificationRuleId,
  NotificationSeverity,
} from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_NEW_PER_SYNC = 20;
/** A dismissal suppresses its key for this long, then the rule may return. */
const DISMISS_SUPPRESS_DAYS = 30;

/** Session clock, so an idle refresh does not rewrite storage every minute. */
let lastSyncAt: number | null = null;

const severityRank: Record<NotificationSeverity, number> = { critical: 0, warning: 1, info: 2 };

function ruleOf(key: string): string {
  return String(key || '').split('|')[0];
}

function nowIso(now: number): string {
  return new Date(now).toISOString();
}

export interface RefreshResult {
  added: number;
  updated: number;
  resolved: number;
  unread: number;
}

/** Run every enabled rule, isolating a broken rule from the rest. */
export function runRules(
  ctx: NotificationContext,
  prefs: NotificationPrefs
): { candidates: NotificationCandidate[]; evaluated: Set<NotificationRuleId> } {
  const evaluated = new Set<NotificationRuleId>();
  const byKey = new Map<string, NotificationCandidate>();
  for (const rule of NOTIFICATION_RULES) {
    if (!prefs.enabled || !prefs.rules[rule.id]) continue;
    evaluated.add(rule.id);
    let produced: NotificationCandidate[] = [];
    try {
      produced = rule.evaluate(ctx, prefs) || [];
    } catch {
      produced = [];
    }
    for (const candidate of produced) {
      if (!candidate || !candidate.dedupeKey || byKey.has(candidate.dedupeKey)) continue;
      byKey.set(candidate.dedupeKey, candidate);
    }
  }
  const candidates = [...byKey.values()].sort(
    (a, b) => severityRank[a.severity] - severityRank[b.severity] || a.dedupeKey.localeCompare(b.dedupeKey)
  );
  return { candidates, evaluated };
}

export interface MergeResult {
  list: AppNotification[];
  added: number;
  updated: number;
  resolved: number;
  newCritical: AppNotification[];
}

/**
 * Merge candidates into the stored inbox.
 *
 * - a dismissed or resolved key is never resurrected;
 * - a live snooze hides the item until its time, then it may update again;
 * - read state is preserved;
 * - an active item whose rule no longer produces it is resolved (hidden), not
 *   deleted, so the history still shows what was handled.
 */
export function mergeCandidates(
  inbox: AppNotification[],
  candidates: NotificationCandidate[],
  evaluated: Set<NotificationRuleId>,
  now: number
): MergeResult {
  const byKey = new Map(inbox.map((n) => [n.dedupeKey, n] as const));
  const candidateKeys = new Set(candidates.map((c) => c.dedupeKey));
  const newCritical: AppNotification[] = [];
  let added = 0;
  let updated = 0;
  let resolved = 0;

  for (const candidate of candidates) {
    const existing = byKey.get(candidate.dedupeKey);
    if (existing) {
      if (existing.resolvedAt) continue;
      const dismissalAge = existing.dismissedAt ? now - Date.parse(existing.dismissedAt) : 0;
      const dismissalLive =
        Boolean(existing.dismissedAt) &&
        (!Number.isFinite(dismissalAge) || dismissalAge < DISMISS_SUPPRESS_DAYS * DAY_MS);
      if (dismissalLive) continue;
      if (existing.snoozedUntil && Date.parse(existing.snoozedUntil) > now) continue;

      const candidateMeta = candidate.meta || existing.meta;
      const unchanged =
        !existing.dismissedAt &&
        !existing.snoozedUntil &&
        existing.kind === candidate.kind &&
        existing.severity === candidate.severity &&
        existing.title === candidate.title &&
        existing.body === candidate.body &&
        JSON.stringify(existing.action) === JSON.stringify(candidate.action) &&
        JSON.stringify(existing.meta) === JSON.stringify(candidateMeta);
      // Nothing new: do not touch storage. An idle 60s pass must not look like
      // new work to the backup/mirror fingerprint.
      if (unchanged) continue;

      byKey.set(candidate.dedupeKey, {
        ...existing,
        kind: candidate.kind,
        severity: candidate.severity,
        title: candidate.title,
        body: candidate.body,
        action: candidate.action,
        meta: candidateMeta,
        // An expired dismissal or snooze comes back unread.
        readAt: existing.dismissedAt ? null : existing.readAt,
        dismissedAt: null,
        snoozedUntil: null,
      });
      updated += 1;
      continue;
    }
    if (added >= MAX_NEW_PER_SYNC) continue;
    const notification: AppNotification = {
      id: candidate.dedupeKey,
      dedupeKey: candidate.dedupeKey,
      kind: candidate.kind,
      severity: candidate.severity,
      title: candidate.title,
      body: candidate.body,
      projectId: candidate.dedupeKey.split('|')[1] || '',
      createdAt: nowIso(now),
      readAt: null,
      dismissedAt: null,
      snoozedUntil: null,
      resolvedAt: null,
      action: candidate.action,
      meta: candidate.meta || {},
    };
    byKey.set(notification.dedupeKey, notification);
    added += 1;
    if (notification.severity === 'critical') newCritical.push(notification);
  }

  for (const notification of [...byKey.values()]) {
    if (notification.dismissedAt || notification.resolvedAt) continue;
    if (!evaluated.has(ruleOf(notification.dedupeKey) as NotificationRuleId)) continue;
    if (candidateKeys.has(notification.dedupeKey)) continue;
    byKey.set(notification.id, { ...notification, resolvedAt: nowIso(now) });
    resolved += 1;
  }

  return {
    list: normalizeInbox([...byKey.values()], now),
    added,
    updated,
    resolved,
    newCritical,
  };
}

let inFlight: Promise<RefreshResult> | null = null;

/**
 * Recompute the inbox. Concurrent calls share one run. `toast: false` is the
 * opening pass: discovering old critical items must not pop a toast on launch.
 */
export function refreshNotifications(
  now = Date.now(),
  options: { toast?: boolean } = {}
): Promise<RefreshResult> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    lastSyncAt = now;
    const prefs = loadPrefs();
    if (!prefs.enabled) {
      return { added: 0, updated: 0, resolved: 0, unread: 0 };
    }
    const ctx = buildNotificationContext(now);
    const { candidates, evaluated } = runRules(ctx, prefs);
    const merged = mergeCandidates(loadInbox(now), candidates, evaluated, now);
    // Only a real change is written; an idle pass leaves storage untouched.
    if (merged.added > 0 || merged.updated > 0 || merged.resolved > 0) {
      saveInbox(merged.list);
    }

    const state = loadNotificationState();
    const beforeToasted = JSON.stringify(state.toasted);
    const toasted = { ...state.toasted };
    if (prefs.toasts && options.toast !== false) {
      for (const notification of merged.newCritical) {
        if (toasted[notification.id]) continue;
        toasted[notification.id] = now;
        notify(notification.title, 'error');
      }
    }
    for (const [key, at] of Object.entries(toasted)) {
      if (!Number.isFinite(at) || now - at > 30 * DAY_MS) delete toasted[key];
    }
    if (JSON.stringify(toasted) !== beforeToasted) {
      saveNotificationState({ lastSync: now, toasted });
    }
    emitNotificationsChanged();

    return {
      added: merged.added,
      updated: merged.updated,
      resolved: merged.resolved,
      unread: unreadCountOf(activeNotifications(merged.list, now)),
    };
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

function mutate(id: string, patch: Partial<AppNotification>, now = Date.now()): void {
  if (!id) return;
  const list = loadInbox(now);
  let changed = false;
  const next = list.map((notification) => {
    if (notification.id !== id) return notification;
    changed = true;
    return { ...notification, ...patch };
  });
  if (!changed) return;
  saveInbox(next);
  emitNotificationsChanged();
}

export function markRead(id: string, now = Date.now()): void {
  const current = loadInbox(now).find((n) => n.id === id);
  if (!current || current.readAt) return;
  mutate(id, { readAt: nowIso(now) }, now);
}

export function markUnread(id: string): void {
  mutate(id, { readAt: null });
}

export function markAllRead(now = Date.now()): void {
  const list = loadInbox(now);
  let changed = false;
  const next = list.map((notification) => {
    if (!isActiveNotification(notification, now) || notification.readAt) return notification;
    changed = true;
    return { ...notification, readAt: nowIso(now) };
  });
  if (!changed) return;
  saveInbox(next);
  emitNotificationsChanged();
}

export function dismiss(id: string, now = Date.now()): void {
  mutate(id, { dismissedAt: nowIso(now), snoozedUntil: null }, now);
}

export function restore(id: string): void {
  mutate(id, { dismissedAt: null, resolvedAt: null, snoozedUntil: null });
}

export function snooze(id: string, days: number, now = Date.now()): void {
  const safeDays = Math.min(30, Math.max(1, Math.round(Number(days) || 1)));
  mutate(id, { snoozedUntil: new Date(now + safeDays * DAY_MS).toISOString(), dismissedAt: null }, now);
}

export function unsnooze(id: string): void {
  mutate(id, { snoozedUntil: null });
}

export function notificationLastSync(): number | null {
  return lastSyncAt ?? loadNotificationState().lastSync;
}

const WATCHED_EVENTS = [
  'contractoros:project-changed',
  'contractoros:boq-changed',
  'contractoros:dsr-changed',
  'contractoros:books-changed',
  'contractoros:ledger-changed',
  'contractoros:stock-changed',
  'contractoros:labour-changed',
  'contractoros:commitments-changed',
  'contractoros:staff-changed',
];

/**
 * Refresh on a timer, on returning to the window, and whenever a watched data
 * set changes. Debounced so a burst of saves produces one pass.
 */
export function startNotificationWatcher(): () => void {
  if (typeof window === 'undefined') return () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void refreshNotifications().catch(() => {
        /* a background refresh must never break the UI */
      });
    }, 250);
  };
  const interval = window.setInterval(schedule, 60_000);
  const onFocus = () => schedule();
  const onVisibility = () => {
    if (document.visibilityState === 'visible') schedule();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key && event.key.includes('contractoros_notification')) reloadNotifications();
  };

  WATCHED_EVENTS.forEach((name) => window.addEventListener(name, schedule));
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('storage', onStorage);

  return () => {
    if (timer) clearTimeout(timer);
    window.clearInterval(interval);
    WATCHED_EVENTS.forEach((name) => window.removeEventListener(name, schedule));
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('storage', onStorage);
  };
}
