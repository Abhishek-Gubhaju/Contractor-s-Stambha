// Notification preferences — per job, restorable, and safe against garbage.
import { readScoped, writeScoped } from '../projectScope';
import {
  NOTIFICATION_RULE_IDS,
  type NotificationPrefs,
  type NotificationRuleId,
  type NotificationRuleMap,
} from './types';

export const NOTIFICATION_PREFS_KEY = 'contractoros_notification_prefs';
export const NOTIFICATION_PREFS_EVENT = 'contractoros:notification-prefs-changed';

/** Rules that are on out of the box; `boq-nearly` is opt-in noise reduction. */
const DEFAULT_OFF: NotificationRuleId[] = ['boq-nearly'];

function defaultRuleMap(): NotificationRuleMap {
  return NOTIFICATION_RULE_IDS.reduce((map, id) => {
    map[id] = !DEFAULT_OFF.includes(id);
    return map;
  }, {} as NotificationRuleMap);
}

export function defaultNotificationPrefs(): NotificationPrefs {
  return {
    enabled: true,
    rules: defaultRuleMap(),
    dueSoonDays: 7,
    dsrStaleDays: 2,
    backupStaleDays: 7,
    toasts: true,
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizePrefs(raw: unknown): NotificationPrefs {
  const defaults = defaultNotificationPrefs();
  const input = raw && typeof raw === 'object' ? (raw as Partial<NotificationPrefs>) : {};
  const rawRules =
    input.rules && typeof input.rules === 'object' ? (input.rules as Partial<NotificationRuleMap>) : {};
  const rules = { ...defaults.rules };
  for (const id of NOTIFICATION_RULE_IDS) {
    if (typeof rawRules[id] === 'boolean') rules[id] = rawRules[id] as boolean;
  }
  return {
    enabled: input.enabled !== false,
    rules,
    dueSoonDays: clampInt(input.dueSoonDays, 0, 30, defaults.dueSoonDays),
    dsrStaleDays: clampInt(input.dsrStaleDays, 1, 14, defaults.dsrStaleDays),
    backupStaleDays: clampInt(input.backupStaleDays, 1, 60, defaults.backupStaleDays),
    toasts: input.toasts !== false,
  };
}

export function loadPrefs(): NotificationPrefs {
  return normalizePrefs(readScoped<unknown>(NOTIFICATION_PREFS_KEY, null));
}

export function savePrefs(patch: Partial<NotificationPrefs>): NotificationPrefs {
  const current = loadPrefs();
  const next = normalizePrefs({
    ...current,
    ...patch,
    rules: { ...current.rules, ...(patch.rules || {}) },
  });
  writeScoped(NOTIFICATION_PREFS_KEY, next);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(NOTIFICATION_PREFS_EVENT));
  }
  return next;
}

export function resetPrefs(): NotificationPrefs {
  const next = defaultNotificationPrefs();
  writeScoped(NOTIFICATION_PREFS_KEY, next);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(NOTIFICATION_PREFS_EVENT));
  }
  return next;
}
