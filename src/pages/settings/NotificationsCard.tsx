// Notification preferences — one switch per rule, three safe thresholds and a
// toast toggle. Everything is per job and validated by savePrefs().
import { useNotifications } from '../../hooks/useNotifications';
import { NOTIFICATION_RULES } from '../../services/notifications/rules';
import { defaultNotificationPrefs } from '../../services/notifications/prefs';

export function NotificationsCard() {
  const { prefs, active, unread, savePreferences, refresh } = useNotifications();
  const rulesOn = NOTIFICATION_RULES.filter((rule) => prefs.rules[rule.id]).length;

  const toggleRule = (id: (typeof NOTIFICATION_RULES)[number]['id'], checked: boolean) => {
    savePreferences({ rules: { ...prefs.rules, [id]: checked } });
  };

  const numberField = (
    label: string,
    hint: string,
    value: number,
    min: number,
    max: number,
    testId: string,
    patch: (n: number) => void
  ) => (
    <label className="text-[11px] text-gray-500 block">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => patch(Number(event.target.value) || 0)}
        aria-label={label}
        data-testid={testId}
        className="mt-0.5 w-full border border-gray-200 rounded px-2 py-1 text-sm text-gray-900"
      />
      <span className="block text-[10px] text-gray-400 mt-0.5">{hint}</span>
    </label>
  );

  return (
    <div className="bg-white rounded-xl border p-6" data-testid="notifications-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold mb-1">Notifications</h2>
          <p className="text-xs text-gray-500">
            Reminders for DSRs, BOQ quantities, bills, stock, payroll, staff and the schedule.
            Everything stays inside the app; nothing is emailed or pushed.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            savePreferences(defaultNotificationPrefs());
            void refresh();
          }}
          data-testid="notif-reset"
          className="text-xs font-medium text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-lg px-2.5 py-1.5"
        >
          Reset defaults
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="inline-flex items-center gap-2 text-sm font-medium text-gray-800">
          <input
            type="checkbox"
            checked={prefs.enabled}
            onChange={(event) => savePreferences({ enabled: event.target.checked })}
            data-testid="notif-master"
            aria-label="Notifications enabled"
            className="h-4 w-4 rounded border-gray-300"
          />
          Notifications on
        </label>
        <span className="text-xs text-gray-500" data-testid="notif-rule-count">
          {rulesOn} of {NOTIFICATION_RULES.length} rules on
          {prefs.enabled ? ` · ${active.length} active · ${unread} unread` : ' · paused'}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
        {numberField(
          'Bill due lead (days)',
          'Show an open bill this many days before its due date.',
          prefs.dueSoonDays,
          0,
          30,
          'notif-due-soon',
          (n) => savePreferences({ dueSoonDays: n })
        )}
        {numberField(
          'DSR draft grace (days)',
          'How long a draft may sit before it is flagged.',
          prefs.dsrStaleDays,
          1,
          14,
          'notif-dsr-stale',
          (n) => savePreferences({ dsrStaleDays: n })
        )}
        {numberField(
          'Backup limit (days)',
          'Warn when the last backup is older than this.',
          prefs.backupStaleDays,
          1,
          60,
          'notif-backup-stale',
          (n) => savePreferences({ backupStaleDays: n })
        )}
      </div>

      <label className="mt-4 inline-flex items-center gap-2 text-sm text-gray-700">
        <input
          type="checkbox"
          checked={prefs.toasts}
          onChange={(event) => savePreferences({ toasts: event.target.checked })}
          data-testid="notif-toasts"
          className="h-4 w-4 rounded border-gray-300"
        />
        Also show a toast for new critical notifications
      </label>

      <div className="mt-5 border-t border-gray-100 pt-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Rules</p>
        <ul className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-2">
          {NOTIFICATION_RULES.map((rule) => (
            <li key={rule.id}>
              <label className="flex items-start gap-2 text-sm text-gray-800">
                <input
                  type="checkbox"
                  checked={prefs.rules[rule.id]}
                  disabled={!prefs.enabled}
                  onChange={(event) => toggleRule(rule.id, event.target.checked)}
                  data-testid={`notif-rule-${rule.id}`}
                  aria-label={rule.label}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 disabled:opacity-40"
                />
                <span>
                  <span className="block">{rule.label}</span>
                  <span className="block text-[11px] text-gray-500">{rule.description}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      <p className="mt-4 text-[11px] text-gray-400">
        Notifications are stored with this job and included in backups. Dismissing hides an item for 30 days.
      </p>
    </div>
  );
}
