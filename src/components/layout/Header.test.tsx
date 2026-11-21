// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Header } from './Header';
import { setActiveProject } from '../../services/projectScope';
import type { AppNotification } from '../../services/notifications/types';

function notification(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: 'dsr-draft|PRJ-001|r1|open',
    dedupeKey: 'dsr-draft|PRJ-001|r1|open',
    kind: 'dsr',
    severity: 'warning',
    title: 'DSR-1 is still a draft',
    body: 'Two days old.',
    projectId: 'PRJ-001',
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    readAt: null,
    dismissedAt: null,
    snoozedUntil: null,
    resolvedAt: null,
    action: { page: 'dsr' },
    meta: {},
    ...overrides,
  };
}

function renderHeader(props: Partial<React.ComponentProps<typeof Header>> = {}) {
  return render(
    <Header
      isSidebarCollapsed={false}
      onToggleSidebar={() => {}}
      currentPage="dashboard"
      {...props}
    />
  );
}

beforeEach(() => {
  localStorage.clear();
  setActiveProject('PRJ-001');
});

afterEach(() => cleanup());

describe('notification bell', () => {
  it('hides the badge when nothing is unread', () => {
    renderHeader({ notifications: [], notificationsUnread: 0 });
    expect(screen.queryByTestId('notification-dot')).toBeNull();
    expect(screen.getByTestId('notifications-bell').getAttribute('aria-label')).toBe('Notifications');
  });

  it('shows the real unread count and caps it at 9+', () => {
    renderHeader({ notifications: [notification()], notificationsUnread: 3 });
    expect(screen.getByTestId('notification-dot').textContent).toBe('3');

    cleanup();
    renderHeader({ notifications: [notification()], notificationsUnread: 12 });
    expect(screen.getByTestId('notification-dot').textContent).toBe('9+');
    expect(screen.getByTestId('notifications-bell').getAttribute('aria-label')).toBe(
      'Notifications, 12 unread'
    );
  });

  it('shows an honest empty state', () => {
    renderHeader({ notifications: [], notificationsUnread: 0 });
    fireEvent.click(screen.getByTestId('notifications-bell'));
    expect(screen.getByTestId('notifications-panel').textContent).toContain(
      "No notifications. You're all caught up."
    );
  });

  it('lists the latest items and opens their page', () => {
    const onNavigate = vi.fn();
    const onMarkNotificationRead = vi.fn();
    const item = notification();
    renderHeader({
      notifications: [item],
      notificationsUnread: 1,
      onNavigate,
      onMarkNotificationRead,
    });
    fireEvent.click(screen.getByTestId('notifications-bell'));
    fireEvent.click(screen.getByText('DSR-1 is still a draft'));

    expect(onMarkNotificationRead).toHaveBeenCalledWith(item.id);
    expect(onNavigate).toHaveBeenCalledWith('dsr');
    expect(screen.queryByTestId('notifications-panel')).toBeNull();
  });

  it('dismisses and snoozes from the panel', () => {
    const onDismissNotification = vi.fn();
    const onSnoozeNotification = vi.fn();
    const item = notification();
    renderHeader({
      notifications: [item],
      notificationsUnread: 1,
      onDismissNotification,
      onSnoozeNotification,
    });
    fireEvent.click(screen.getByTestId('notifications-bell'));

    fireEvent.click(screen.getByLabelText(`Dismiss ${item.title}`));
    expect(onDismissNotification).toHaveBeenCalledWith(item.id);

    fireEvent.change(screen.getByLabelText(`Snooze ${item.title}`), { target: { value: '3' } });
    expect(onSnoozeNotification).toHaveBeenCalledWith(item.id, 3);
  });

  it('marks all read and navigates to the full page', () => {
    const onMarkAllNotificationsRead = vi.fn();
    const onNavigate = vi.fn();
    renderHeader({
      notifications: [notification()],
      notificationsUnread: 1,
      onMarkAllNotificationsRead,
      onNavigate,
    });
    fireEvent.click(screen.getByTestId('notifications-bell'));
    fireEvent.click(screen.getByTestId('notifications-mark-all'));
    expect(onMarkAllNotificationsRead).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('notifications-view-all'));
    expect(onNavigate).toHaveBeenCalledWith('notifications');
  });

  it('closes the panel on Escape and outside click', () => {
    renderHeader({ notifications: [notification()], notificationsUnread: 1 });
    fireEvent.click(screen.getByTestId('notifications-bell'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('notifications-panel')).toBeNull();

    fireEvent.click(screen.getByTestId('notifications-bell'));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('notifications-panel')).toBeNull();
  });
});
