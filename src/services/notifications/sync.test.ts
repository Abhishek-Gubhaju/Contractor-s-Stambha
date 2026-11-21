// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { notifyMock } = vi.hoisted(() => ({ notifyMock: vi.fn() }));

vi.mock('../../components/ui/DialogHost', () => ({
  notify: (...args: unknown[]) => notifyMock(...args),
  DialogHost: () => null,
}));

import { setActiveProject, writeScoped } from '../projectScope';
import { RESTORABLE_KEYS } from '../backup/backupService';
import { defaultNotificationPrefs, savePrefs } from './prefs';
import {
  activeNotifications,
  loadInbox,
  resetNotificationsForTests,
  saveInbox,
  unreadCountOf,
} from './inbox';
import {
  dismiss,
  markAllRead,
  markRead,
  mergeCandidates,
  refreshNotifications,
  runRules,
  snooze,
  startNotificationWatcher,
} from './sync';
import type { AppNotification, NotificationCandidate, NotificationContext } from './types';

const NOW = Date.parse('2026-11-20T06:00:00.000Z');

function boqSection() {
  return [
    {
      id: 's1',
      sectionCode: '1',
      description: 'Section',
      amount: 0,
      isSection: true,
      children: [
        {
          id: 'i1',
          sectionCode: '1',
          itemCode: 'A',
          description: 'Item',
          unit: 'm3',
          estimatedQuantity: 10,
          rate: 100,
          amount: 0,
          actualMaterialCost: 0,
          actualLaborCost: 0,
          completedQuantity: 0,
        },
      ],
    },
  ];
}

function dsrReport() {
  return {
    id: 'r1',
    reportNo: 'DSR-1',
    date: '2026-11-20',
    status: 'draft',
    submittedAt: '',
    approvedAt: '',
    items: [{ id: 'i1', boqCode: 'A', description: 'Slab', unit: 'm3', quantity: 12 }],
    attachments: [],
    labour: [],
    plant: [],
    materials: [],
    tests: [],
    delays: [],
  };
}

function seedOverrun() {
  writeScoped('contractoros_boq', boqSection());
  writeScoped('contractoros_dsr', [dsrReport()]);
}

function notification(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: 'dsr-draft|PRJ-001|r1|open',
    dedupeKey: 'dsr-draft|PRJ-001|r1|open',
    kind: 'dsr',
    severity: 'warning',
    title: 'A reminder',
    body: 'Body',
    projectId: 'PRJ-001',
    createdAt: '2026-11-20T05:00:00.000Z',
    readAt: null,
    dismissedAt: null,
    snoozedUntil: null,
    resolvedAt: null,
    action: { page: 'dsr' },
    meta: {},
    ...overrides,
  };
}

/** The backup rule is machine-level and would add a "No backup yet" item to
 * every fixture; these tests isolate the rule they are proving. */
function quietPrefs() {
  const prefs = defaultNotificationPrefs();
  prefs.rules['backup-stale'] = false;
  return prefs;
}

beforeEach(() => {
  localStorage.clear();
  setActiveProject('PRJ-001');
  resetNotificationsForTests();
  savePrefs(quietPrefs());
  notifyMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('refresh', () => {
  it('creates one notification per condition and never duplicates it', async () => {
    seedOverrun();
    const first = await refreshNotifications(NOW);
    expect(first.added).toBe(1);
    expect(first.unread).toBe(1);
    expect(loadInbox(NOW)).toHaveLength(1);

    const second = await refreshNotifications(NOW + 1000);
    expect(second.added).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.resolved).toBe(0);
    expect(loadInbox(NOW)).toHaveLength(1);
  });

  it('raises one toast for a new critical item, but none on the opening pass', async () => {
    seedOverrun();
    await refreshNotifications(NOW, { toast: false });
    expect(notifyMock).not.toHaveBeenCalled();

    localStorage.clear();
    resetNotificationsForTests();
    setActiveProject('PRJ-001');
    savePrefs(quietPrefs());
    seedOverrun();
    await refreshNotifications(NOW);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(String(notifyMock.mock.calls[0][0])).toMatch(/BOQ A/);
  });

  it('does nothing at all while notifications are switched off', async () => {
    seedOverrun();
    savePrefs({ enabled: false });
    const result = await refreshNotifications(NOW);
    expect(result).toEqual({ added: 0, updated: 0, resolved: 0, unread: 0 });
    expect(loadInbox(NOW)).toHaveLength(0);
  });

  it('resolves an item whose condition has gone, without deleting it', async () => {
    seedOverrun();
    await refreshNotifications(NOW);
    const [item] = loadInbox(NOW);

    writeScoped('contractoros_dsr', []);
    await refreshNotifications(NOW + 1000);

    const stored = loadInbox(NOW + 1000).find((n) => n.id === item.id);
    expect(stored?.resolvedAt).toBeTruthy();
    expect(activeNotifications(loadInbox(NOW + 1000), NOW + 1000)).toHaveLength(0);
  });

  it('keeps each job’s inbox separate', async () => {
    seedOverrun();
    await refreshNotifications(NOW);
    expect(loadInbox(NOW)).toHaveLength(1);

    setActiveProject('PRJ-002');
    savePrefs(quietPrefs());
    await refreshNotifications(NOW);
    expect(loadInbox(NOW)).toHaveLength(0);

    setActiveProject('PRJ-001');
    expect(loadInbox(NOW)).toHaveLength(1);
  });

  it('refreshes when a watched store changes and stops cleanly', async () => {
    vi.useFakeTimers();
    const stop = startNotificationWatcher();
    seedOverrun();
    window.dispatchEvent(new Event('contractoros:boq-changed'));
    await vi.advanceTimersByTimeAsync(300);
    expect(loadInbox(NOW)).toHaveLength(1);

    stop();
    writeScoped('contractoros_dsr', []);
    window.dispatchEvent(new Event('contractoros:boq-changed'));
    await vi.advanceTimersByTimeAsync(300);
    expect(loadInbox(NOW)).toHaveLength(1);
  });

  it('survives a malformed legacy stock row while building the context', async () => {
    writeScoped('contractoros_stock_items', [null, { id: 'ok', name: 'Cement', unit: 'bag', reorderLevel: 1 }]);
    await expect(refreshNotifications(NOW)).resolves.toBeTruthy();
  });

  it('survives a source row that would make one rule throw', () => {
    const ctx = {
      now: NOW,
      todayAD: '2026-11-20',
      timezone: 'Asia/Kathmandu',
      projectId: 'PRJ-001',
      dsr: [],
      boq: [],
      stock: [null],
      payrollRuns: [],
      activities: [],
      milestones: [],
      staffLeave: [],
      loadParties: () => [],
      backup: { last: null, auto: null, desktop: true },
    } as unknown as NotificationContext;
    const { candidates } = runRules(ctx, defaultNotificationPrefs());
    expect(candidates.some((n) => n.kind === 'backup')).toBe(true);
  });
});

describe('actions', () => {
  it('marks read and keeps the read state through a refresh', async () => {
    seedOverrun();
    await refreshNotifications(NOW);
    const [item] = loadInbox(NOW);
    markRead(item.id, NOW);
    expect(loadInbox(NOW)[0].readAt).toBeTruthy();

    await refreshNotifications(NOW + 1000);
    expect(loadInbox(NOW + 1000)[0].readAt).toBeTruthy();
    expect(unreadCountOf(activeNotifications(loadInbox(NOW + 1000), NOW + 1000))).toBe(0);
  });

  it('marks every active item read', async () => {
    saveInbox([notification(), notification({ id: 'b', dedupeKey: 'b' })], 'PRJ-001');
    markAllRead(NOW);
    expect(loadInbox(NOW).every((n) => Boolean(n.readAt))).toBe(true);
  });

  it('never resurrects a dismissed item', async () => {
    seedOverrun();
    await refreshNotifications(NOW);
    const [item] = loadInbox(NOW);
    dismiss(item.id, NOW);

    await refreshNotifications(NOW + 1000);
    const stored = loadInbox(NOW + 1000).find((n) => n.id === item.id);
    expect(stored?.dismissedAt).toBeTruthy();
    expect(activeNotifications(loadInbox(NOW + 1000), NOW + 1000)).toHaveLength(0);
  });

  it('brings a dismissed key back after thirty days if the condition remains', async () => {
    seedOverrun();
    await refreshNotifications(NOW);
    const [item] = loadInbox(NOW);
    dismiss(item.id, NOW);

    await refreshNotifications(NOW + 10 * 24 * 60 * 60 * 1000);
    expect(activeNotifications(loadInbox(NOW), NOW + 10 * 24 * 60 * 60 * 1000)).toHaveLength(0);

    const later = NOW + 31 * 24 * 60 * 60 * 1000;
    await refreshNotifications(later);
    const stored = loadInbox(later).find((n) => n.id === item.id);
    expect(stored?.dismissedAt).toBeNull();
    expect(stored?.readAt).toBeNull();
    expect(activeNotifications(loadInbox(later), later)).toHaveLength(1);
  });

  it('hides a snoozed item until its time and shows it again afterwards', async () => {
    seedOverrun();
    await refreshNotifications(NOW);
    const [item] = loadInbox(NOW);
    snooze(item.id, 1, NOW);

    await refreshNotifications(NOW + 1000);
    expect(activeNotifications(loadInbox(NOW + 1000), NOW + 1000)).toHaveLength(0);

    await refreshNotifications(NOW + 2 * 24 * 60 * 60 * 1000);
    const stored = loadInbox(NOW + 2 * 24 * 60 * 60 * 1000).find((n) => n.id === item.id);
    expect(stored?.snoozedUntil).toBeNull();
  });
});

describe('merge and backup safety', () => {
  it('caps a single sync at twenty new notifications', () => {
    const candidates: NotificationCandidate[] = Array.from({ length: 25 }, (_, index) => ({
      dedupeKey: `boq-overrun|PRJ-001|${index}`,
      kind: 'boq',
      severity: 'warning',
      title: `Overrun ${index}`,
      body: '',
      action: { page: 'boq' },
    }));
    const merged = mergeCandidates([], candidates, new Set(), NOW);
    expect(merged.added).toBe(20);
  });

  it('keeps notification stores restorable and scoped', async () => {
    for (const key of [
      'contractoros_notifications',
      'contractoros_notification_prefs',
      'contractoros_notification_state',
    ]) {
      expect(RESTORABLE_KEYS.has(key)).toBe(true);
    }
    seedOverrun();
    await refreshNotifications(NOW);
    expect(loadInbox(NOW)).toHaveLength(1);
  });
});
