// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NotificationsPage from './Notifications';
import { setActiveProject } from '../services/projectScope';
import {
  loadInbox,
  resetNotificationsForTests,
  saveInbox,
} from '../services/notifications/inbox';
import type { AppNotification } from '../services/notifications/types';

const NOW = Date.now();

function notification(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: 'dsr-draft|PRJ-001|r1|open',
    dedupeKey: 'dsr-draft|PRJ-001|r1|open',
    kind: 'dsr',
    severity: 'warning',
    title: 'DSR-1 is still a draft',
    body: 'Two days old.',
    projectId: 'PRJ-001',
    createdAt: new Date(NOW - 3_600_000).toISOString(),
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

afterEach(() => cleanup());

describe('notifications page', () => {
  it('shows an honest empty state', async () => {
    render(<NotificationsPage />);
    expect(await screen.findByText("You're all caught up")).toBeTruthy();
    expect(screen.getByTestId('notifications-page').textContent).toContain('0 active');
  });

  it('renders active items and their counts', async () => {
    saveInbox([notification(), notification({ id: 'b', dedupeKey: 'b', title: 'Second' })]);
    render(<NotificationsPage />);
    expect(await screen.findByText('DSR-1 is still a draft')).toBeTruthy();
    expect(screen.getByTestId('notification-filter-all').textContent).toContain('All 2');
    expect(screen.getByTestId('notification-filter-unread').textContent).toContain('Unread 2');
  });

  it('filters by unread, critical and type', async () => {
    saveInbox([
      notification(),
      notification({
        id: 'boq-overrun|PRJ-001|A',
        dedupeKey: 'boq-overrun|PRJ-001|A',
        kind: 'boq',
        severity: 'critical',
        title: 'BOQ A is over',
        readAt: new Date().toISOString(),
      }),
    ]);
    render(<NotificationsPage />);
    await screen.findByText('DSR-1 is still a draft');

    fireEvent.click(screen.getByTestId('notification-filter-unread'));
    expect(screen.queryByText('BOQ A is over')).toBeNull();

    fireEvent.click(screen.getByTestId('notification-filter-critical'));
    expect(screen.getByText('BOQ A is over')).toBeTruthy();
    expect(screen.queryByText('DSR-1 is still a draft')).toBeNull();

    fireEvent.click(screen.getByTestId('notification-filter-all'));
    fireEvent.change(screen.getByTestId('notification-kind-filter'), { target: { value: 'boq' } });
    expect(screen.getByText('BOQ A is over')).toBeTruthy();
    expect(screen.queryByText('DSR-1 is still a draft')).toBeNull();
  });

  it('marks one item read and then all read', async () => {
    const first = notification();
    saveInbox([first, notification({ id: 'b', dedupeKey: 'b', title: 'Second' })]);
    render(<NotificationsPage />);
    const row = await screen.findByTestId(`notification-row-${first.id}`);
    fireEvent.click(within(row).getByText('Mark read'));
    await waitFor(() => expect(loadInbox().find((n) => n.id === first.id)?.readAt).toBeTruthy());

    fireEvent.click(screen.getByTestId('notifications-page-mark-all'));
    await waitFor(() => expect(loadInbox().every((n) => Boolean(n.readAt))).toBe(true));
  });

  it('snoozes an item out of the active list', async () => {
    const item = notification();
    saveInbox([item]);
    render(<NotificationsPage />);
    const row = await screen.findByTestId(`notification-row-${item.id}`);
    fireEvent.change(within(row).getByLabelText(`Snooze ${item.title}`), { target: { value: '3' } });

    await waitFor(() => expect(screen.queryByTestId(`notification-row-${item.id}`)).toBeNull());
    expect(screen.getByTestId('notifications-snoozed').textContent).toContain(item.title);
    expect(loadInbox()[0].snoozedUntil).toBeTruthy();
  });

  it('dismisses into the archive and restores it', async () => {
    const item = notification();
    saveInbox([item]);
    render(<NotificationsPage />);
    const row = await screen.findByTestId(`notification-row-${item.id}`);
    fireEvent.click(within(row).getByText('Dismiss'));

    await waitFor(() => expect(screen.queryByTestId(`notification-row-${item.id}`)).toBeNull());
    expect(screen.getByTestId('notifications-archive').textContent).toContain(item.title);

    fireEvent.click(within(screen.getByTestId('notifications-archive')).getByText('Restore'));
    await waitFor(() => expect(screen.getByTestId(`notification-row-${item.id}`)).toBeTruthy());
    expect(loadInbox()[0].dismissedAt).toBeNull();
  });

  it('opens the notification target and marks it read', async () => {
    const onNavigate = vi.fn();
    const item = notification();
    saveInbox([item]);
    render(<NotificationsPage onNavigate={onNavigate} />);
    fireEvent.click(await screen.findByText(item.title));

    expect(onNavigate).toHaveBeenCalledWith('dsr');
    await waitFor(() => expect(loadInbox()[0].readAt).toBeTruthy());
  });

  it('links to notification settings', async () => {
    const onNavigate = vi.fn();
    render(<NotificationsPage onNavigate={onNavigate} />);
    fireEvent.click(screen.getByTestId('notifications-prefs-link'));
    expect(onNavigate).toHaveBeenCalledWith('settings');
  });

  it('hides a rule’s items as soon as that rule is switched off', async () => {
    const item = notification();
    saveInbox([item]);
    render(<NotificationsPage />);
    expect(await screen.findByTestId(`notification-row-${item.id}`)).toBeTruthy();

    const { loadPrefs, savePrefs } = await import('../services/notifications/prefs');
    act(() => savePrefs({ rules: { ...loadPrefs().rules, 'dsr-draft': false } }));
    await waitFor(() => expect(screen.queryByTestId(`notification-row-${item.id}`)).toBeNull());
  });

  it('says notifications are paused when the master switch is off', async () => {
    const { savePrefs } = await import('../services/notifications/prefs');
    act(() => savePrefs({ enabled: false }));
    render(<NotificationsPage />);
    expect(await screen.findByText('Notifications are switched off in Settings.')).toBeTruthy();
  });
});
