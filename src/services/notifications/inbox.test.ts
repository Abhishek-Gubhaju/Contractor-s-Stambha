// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  activeNotifications,
  isActiveNotification,
  loadInbox,
  normalizeInbox,
  normalizeNotification,
  resetNotificationsForTests,
  saveInbox,
  unreadCountOf,
} from './inbox';
import { setActiveProject } from '../projectScope';

const NOW = Date.parse('2026-11-20T06:00:00.000Z');

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dsr-draft|PRJ-001|r1|open',
    dedupeKey: 'dsr-draft|PRJ-001|r1|open',
    kind: 'dsr',
    severity: 'warning',
    title: 'DSR-1 is a draft',
    body: 'Two days old.',
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

beforeEach(() => {
  localStorage.clear();
  setActiveProject('PRJ-001');
  resetNotificationsForTests();
});

describe('normalization', () => {
  it('keeps a valid row and clamps text', () => {
    const parsed = normalizeNotification(row({ title: `  ${'x'.repeat(300)}  `, body: ' a \n b ' }));
    expect(parsed?.title.length).toBe(140);
    expect(parsed?.body).toBe('a b');
  });

  it('drops rows without an id, a created time or a known kind', () => {
    expect(normalizeNotification(row({ id: '', dedupeKey: '' }))).toBeNull();
    expect(normalizeNotification(row({ createdAt: 'not-a-date' }))).toBeNull();
    expect(normalizeNotification(row({ kind: 'unknown' }))).toBeNull();
    expect(normalizeNotification(null)).toBeNull();
  });

  it('falls back to the dashboard for an unknown action page', () => {
    expect(normalizeNotification(row({ action: { page: 'not-a-page' } }))?.action.page).toBe('dashboard');
  });

  it('keeps the newest copy of a duplicated id', () => {
    const list = normalizeInbox(
      [
        row({ title: 'old', createdAt: '2026-11-19T05:00:00.000Z' }),
        row({ title: 'new', createdAt: '2026-11-20T05:00:00.000Z' }),
      ],
      NOW
    );
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('new');
  });
});

describe('pruning', () => {
  it('drops read rows older than 60 days', () => {
    const list = normalizeInbox([row({ readAt: '2026-09-01T00:00:00.000Z' })], NOW);
    expect(list).toHaveLength(0);
  });

  it('drops dismissed rows older than 90 days and keeps recent dismissals', () => {
    expect(normalizeInbox([row({ dismissedAt: '2026-08-01T00:00:00.000Z' })], NOW)).toHaveLength(0);
    expect(normalizeInbox([row({ dismissedAt: '2026-11-01T00:00:00.000Z' })], NOW)).toHaveLength(1);
  });

  it('drops resolved history older than 30 days', () => {
    expect(normalizeInbox([row({ resolvedAt: '2026-10-01T00:00:00.000Z' })], NOW)).toHaveLength(0);
  });

  it('caps the stored list at 500, newest first', () => {
    const rows = Array.from({ length: 520 }, (_, index) =>
      row({
        id: `dsr-draft|PRJ-001|r${index}|open`,
        dedupeKey: `dsr-draft|PRJ-001|r${index}|open`,
        createdAt: new Date(NOW - index * 60_000).toISOString(),
      })
    );
    const list = normalizeInbox(rows, NOW);
    expect(list).toHaveLength(500);
    expect(list[0].title).toBe('DSR-1 is a draft');
  });
});

describe('visibility', () => {
  it('hides dismissed, resolved and currently snoozed items', () => {
    const dismissed = normalizeNotification(row({ dismissedAt: '2026-11-20T05:30:00.000Z' }))!;
    const resolved = normalizeNotification(row({ id: 'b', dedupeKey: 'b', resolvedAt: '2026-11-20T05:30:00.000Z' }))!;
    const snoozed = normalizeNotification(row({ id: 'c', dedupeKey: 'c', snoozedUntil: '2026-11-21T05:00:00.000Z' }))!;
    const open = normalizeNotification(row({ id: 'd', dedupeKey: 'd' }))!;
    expect(isActiveNotification(dismissed, NOW)).toBe(false);
    expect(isActiveNotification(resolved, NOW)).toBe(false);
    expect(isActiveNotification(snoozed, NOW)).toBe(false);
    expect(activeNotifications([dismissed, resolved, snoozed, open], NOW)).toHaveLength(1);
  });

  it('counts unread items only', () => {
    const list = normalizeInbox([row(), row({ id: 'b', dedupeKey: 'b', readAt: '2026-11-20T05:30:00.000Z' })], NOW);
    expect(unreadCountOf(list)).toBe(1);
  });
});

describe('storage', () => {
  it('writes and reads a scoped inbox, and isolates jobs', () => {
    saveInbox(normalizeInbox([row()], NOW));
    expect(loadInbox(NOW)).toHaveLength(1);
    setActiveProject('PRJ-002');
    expect(loadInbox(NOW)).toHaveLength(0);
    setActiveProject('PRJ-001');
    expect(loadInbox(NOW)).toHaveLength(1);
  });
});
