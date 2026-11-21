// The one hook the bell, the page and the settings card share. The inbox is an
// external store so every surface updates together, including a second window.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  activeNotifications,
  getNotificationsSnapshot,
  reloadNotifications,
  subscribeNotifications,
  unreadCountOf,
} from '../services/notifications/inbox';
import {
  NOTIFICATION_PREFS_EVENT,
  loadPrefs,
  savePrefs,
} from '../services/notifications/prefs';
import {
  dismiss,
  markAllRead,
  markRead,
  markUnread,
  notificationLastSync,
  refreshNotifications,
  restore,
  snooze,
  unsnooze,
} from '../services/notifications/sync';
import type { NotificationPrefs, NotificationRuleId } from '../services/notifications/types';
import { PROJECT_CHANGED_EVENT } from '../services/projectScope';

export interface UseNotifications {
  items: ReturnType<typeof getNotificationsSnapshot>;
  active: ReturnType<typeof getNotificationsSnapshot>;
  unread: number;
  prefs: NotificationPrefs;
  error: string;
  refreshing: boolean;
  lastSync: number | null;
  refresh: () => Promise<void>;
  savePreferences: (patch: Partial<NotificationPrefs>) => NotificationPrefs;
  markRead: typeof markRead;
  markUnread: typeof markUnread;
  markAllRead: typeof markAllRead;
  dismiss: typeof dismiss;
  restore: typeof restore;
  snooze: typeof snooze;
  unsnooze: typeof unsnooze;
}

export function useNotifications(): UseNotifications {
  const items = useSyncExternalStore(
    subscribeNotifications,
    getNotificationsSnapshot,
    getNotificationsSnapshot
  );
  const [prefs, setPrefs] = useState<NotificationPrefs>(() => loadPrefs());
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [lastSync, setLastSync] = useState<number | null>(() => notificationLastSync());

  useEffect(() => {
    setLastSync(notificationLastSync());
  }, [items]);

  useEffect(() => {
    const onPrefs = () => setPrefs(loadPrefs());
    const onProject = () => {
      reloadNotifications();
      setPrefs(loadPrefs());
    };
    window.addEventListener(NOTIFICATION_PREFS_EVENT, onPrefs);
    window.addEventListener(PROJECT_CHANGED_EVENT, onProject);
    return () => {
      window.removeEventListener(NOTIFICATION_PREFS_EVENT, onPrefs);
      window.removeEventListener(PROJECT_CHANGED_EVENT, onProject);
    };
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshNotifications();
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, []);

  const savePreferences = useCallback((patch: Partial<NotificationPrefs>) => {
    const next = savePrefs(patch);
    setPrefs(next);
    void refreshNotifications().catch(() => {
      /* the next watcher pass retries */
    });
    return next;
  }, []);

  // A switched-off rule disappears at once, without losing its stored item:
  // switching it back on shows the same reminder with its read state intact.
  const active = prefs.enabled
    ? activeNotifications(items).filter((notification) => {
        const ruleId = notification.dedupeKey.split('|')[0] as NotificationRuleId;
        return prefs.rules[ruleId] !== false;
      })
    : [];

  return {
    items,
    active,
    unread: unreadCountOf(active),
    prefs,
    error,
    refreshing,
    lastSync,
    refresh,
    savePreferences,
    markRead,
    markUnread,
    markAllRead,
    dismiss,
    restore,
    snooze,
    unsnooze,
  };
}
