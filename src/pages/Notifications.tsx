// The full inbox. Same external store as the bell, so the two always agree.
import { useMemo, useState } from 'react';
import { Bell, Clock, RefreshCw, Settings2, X } from 'lucide-react';
import { useNotifications } from '../hooks/useNotifications';
import {
  dayLabel,
  KIND_LABEL,
  projectLabel,
  relativeTime,
  SEVERITY_DOT,
  SEVERITY_PILL,
} from '../services/notifications/format';
import { NOTIFICATION_KINDS, type AppNotification, type NotificationKind } from '../services/notifications/types';
import { cn } from '../utils';

type Filter = 'all' | 'unread' | 'critical';

function NotificationRow({
  notification,
  onOpen,
  onMarkRead,
  onMarkUnread,
  onDismiss,
  onRestore,
  onSnooze,
}: {
  notification: AppNotification;
  onOpen: (notification: AppNotification) => void;
  onMarkRead: (id: string) => void;
  onMarkUnread: (id: string) => void;
  onDismiss: (id: string) => void;
  onRestore: (id: string) => void;
  onSnooze: (id: string, days: number) => void;
}) {
  const archived = Boolean(notification.dismissedAt || notification.resolvedAt);
  return (
    <div
      data-testid={`notification-row-${notification.id}`}
      className={cn(
        'px-4 py-3 flex items-start gap-3',
        !notification.readAt && !archived && 'bg-blue-50/40'
      )}
    >
      <span className={cn('mt-1.5 w-2 h-2 rounded-full shrink-0', SEVERITY_DOT[notification.severity])} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <button type="button" onClick={() => onOpen(notification)} className="block w-full text-left">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-gray-900">{notification.title}</span>
            <span className={cn('text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border', SEVERITY_PILL[notification.severity])}>
              {notification.severity}
            </span>
          </span>
          <span className="block text-sm text-gray-600 mt-0.5">{notification.body}</span>
          <span className="block text-[11px] text-gray-400 mt-1">
            {KIND_LABEL[notification.kind]} · {projectLabel(notification.projectId)} ·{' '}
            {relativeTime(notification.createdAt)}
            {archived ? ' · archived' : notification.readAt ? '' : ' · unread'}
          </span>
        </button>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {archived ? (
            <button
              type="button"
              onClick={() => onRestore(notification.id)}
              className="text-[11px] font-medium text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded px-2 py-0.5"
            >
              Restore
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => onMarkRead(notification.id)}
                disabled={Boolean(notification.readAt)}
                className="text-[11px] font-medium text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 disabled:text-gray-300 disabled:cursor-default rounded px-2 py-0.5"
              >
                Mark read
              </button>
              <button
                type="button"
                onClick={() => onMarkUnread(notification.id)}
                className="text-[11px] font-medium text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded px-2 py-0.5"
              >
                Mark unread
              </button>
              <select
                aria-label={`Snooze ${notification.title}`}
                value=""
                onChange={(event) => {
                  const days = Number(event.target.value);
                  if (days > 0) onSnooze(notification.id, days);
                }}
                className="text-[11px] text-gray-600 border border-gray-200 rounded px-1.5 py-0.5 bg-white"
              >
                <option value="">Snooze…</option>
                <option value="1">1 day</option>
                <option value="3">3 days</option>
                <option value="7">1 week</option>
              </select>
              <button
                type="button"
                onClick={() => onDismiss(notification.id)}
                className="text-[11px] font-medium text-gray-500 hover:text-rose-700 inline-flex items-center gap-1 px-1 py-0.5"
              >
                <X className="w-3 h-3" /> Dismiss
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function NotificationsPage({ onNavigate }: { onNavigate?: (page: string) => void }) {
  const {
    items,
    active,
    unread,
    prefs,
    refreshing,
    error,
    lastSync,
    refresh,
    markRead,
    markUnread,
    markAllRead,
    dismiss,
    restore,
    snooze,
    unsnooze,
  } = useNotifications();
  const [filter, setFilter] = useState<Filter>('all');
  const [kind, setKind] = useState<'all' | NotificationKind>('all');

  const filtered = useMemo(() => {
    return active
      .filter((n) => (filter === 'unread' ? !n.readAt : filter === 'critical' ? n.severity === 'critical' : true))
      .filter((n) => (kind === 'all' ? true : n.kind === kind));
  }, [active, filter, kind]);

  const groups = useMemo(() => {
    const map = new Map<string, AppNotification[]>();
    for (const notification of filtered) {
      const key = dayLabel(notification.createdAt);
      const list = map.get(key) || [];
      list.push(notification);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [filtered]);

  const snoozed = useMemo(
    () =>
      items.filter(
        (n) =>
          !n.dismissedAt &&
          !n.resolvedAt &&
          n.snoozedUntil &&
          Date.parse(n.snoozedUntil) > Date.now()
      ),
    [items]
  );
  const archived = useMemo(
    () => items.filter((n) => Boolean(n.dismissedAt || n.resolvedAt)),
    [items]
  );
  const criticalCount = active.filter((n) => n.severity === 'critical').length;

  const open = (notification: AppNotification) => {
    markRead(notification.id);
    onNavigate?.(notification.action.page);
  };

  return (
    <div className="space-y-5" data-testid="notifications-page">
      <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-3">
        <div>
          <h1>Notifications</h1>
          <p className="text-sm text-gray-500 mt-1">
            {unread > 0 ? `${unread} unread` : 'You are all caught up'} · {active.length} active
            {lastSync ? ` · checked ${relativeTime(new Date(lastSync).toISOString())}` : ''}
          </p>
          {!prefs.enabled && (
            <p className="mt-1 text-xs text-amber-700">Notifications are switched off in Settings.</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            data-testid="notifications-refresh"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-50 rounded-lg px-3 py-1.5"
          >
            <RefreshCw className={cn('w-4 h-4', refreshing && 'animate-spin')} /> Refresh
          </button>
          <button
            type="button"
            onClick={() => markAllRead()}
            disabled={unread === 0}
            data-testid="notifications-page-mark-all"
            className="text-sm font-medium text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-40 rounded-lg px-3 py-1.5"
          >
            Mark all read
          </button>
          <button
            type="button"
            onClick={() => onNavigate?.('settings')}
            data-testid="notifications-prefs-link"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg px-3 py-1.5"
          >
            <Settings2 className="w-4 h-4" /> Notification settings
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-700 bg-white border border-gray-200 border-l-2 border-l-red-600 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ['all', `All ${active.length}`],
            ['unread', `Unread ${unread}`],
            ['critical', `Critical ${criticalCount}`],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            data-testid={`notification-filter-${value}`}
            aria-pressed={filter === value}
            className={cn(
              'text-sm rounded-lg border px-3 py-1.5',
              filter === value
                ? 'bg-amber-50 text-amber-900 border-amber-300'
                : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
            )}
          >
            {label}
          </button>
        ))}
        <select
          aria-label="Filter by type"
          value={kind}
          onChange={(event) => setKind(event.target.value as 'all' | NotificationKind)}
          data-testid="notification-kind-filter"
          className="ml-auto text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white"
        >
          <option value="all">All types</option>
          {NOTIFICATION_KINDS.map((value) => (
            <option key={value} value={value}>
              {KIND_LABEL[value]}
            </option>
          ))}
        </select>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {groups.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <Bell className="w-7 h-7 mx-auto text-gray-300" />
            <p className="mt-2 text-sm font-medium text-gray-700">You're all caught up</p>
            <p className="text-xs text-gray-500 mt-0.5">
              {filter === 'all' && kind === 'all'
                ? 'Nothing needs attention right now.'
                : 'No notifications match this filter.'}
            </p>
          </div>
        ) : (
          groups.map(([day, rows]) => (
            <section key={day}>
              <h2 className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500 bg-gray-50 border-y border-gray-100 first:border-t-0">
                {day}
              </h2>
              <div className="divide-y divide-gray-100">
                {rows.map((notification) => (
                  <NotificationRow
                    key={notification.id}
                    notification={notification}
                    onOpen={open}
                    onMarkRead={markRead}
                    onMarkUnread={markUnread}
                    onDismiss={dismiss}
                    onRestore={restore}
                    onSnooze={snooze}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      {snoozed.length > 0 && (
        <details className="bg-white rounded-xl border border-gray-200 px-4 py-3" data-testid="notifications-snoozed">
          <summary className="cursor-pointer text-sm font-semibold text-gray-800">
            Snoozed ({snoozed.length})
          </summary>
          <ul className="mt-3 divide-y divide-gray-100">
            {snoozed.map((notification) => (
              <li key={notification.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0">
                  <span className="block text-sm text-gray-900">{notification.title}</span>
                  <span className="block text-[11px] text-gray-500">
                    <Clock className="inline w-3 h-3 mr-1" />
                    returns {new Date(notification.snoozedUntil || '').toLocaleString()}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => unsnooze(notification.id)}
                  className="text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded px-2 py-0.5"
                >
                  Unsnooze
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {archived.length > 0 && (
        <details className="bg-white rounded-xl border border-gray-200 px-4 py-3" data-testid="notifications-archive">
          <summary className="cursor-pointer text-sm font-semibold text-gray-800">
            Dismissed &amp; resolved ({archived.length})
          </summary>
          <ul className="mt-3 divide-y divide-gray-100">
            {archived.map((notification) => (
              <li key={notification.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0">
                  <span className="block text-sm text-gray-700">{notification.title}</span>
                  <span className="block text-[11px] text-gray-500">
                    {relativeTime(notification.dismissedAt || notification.resolvedAt || notification.createdAt)}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => restore(notification.id)}
                  className="text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded px-2 py-0.5"
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
