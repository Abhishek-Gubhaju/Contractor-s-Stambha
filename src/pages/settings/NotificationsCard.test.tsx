// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotificationsCard } from './NotificationsCard';
import { setActiveProject } from '../../services/projectScope';
import { defaultNotificationPrefs, loadPrefs, savePrefs } from '../../services/notifications/prefs';
import { resetNotificationsForTests } from '../../services/notifications/inbox';

beforeEach(() => {
  localStorage.clear();
  setActiveProject('PRJ-001');
  resetNotificationsForTests();
  savePrefs(defaultNotificationPrefs());
});

afterEach(() => cleanup());

describe('notification preferences', () => {
  it('shows the default rule count and toggles the master switch', async () => {
    render(<NotificationsCard />);
    expect(screen.getByTestId('notif-rule-count').textContent).toContain('11 of 12 rules on');
    expect((screen.getByTestId('notif-master') as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByTestId('notif-master'));
    await waitFor(() => expect(loadPrefs().enabled).toBe(false));
  });

  it('persists a rule toggle', async () => {
    render(<NotificationsCard />);
    fireEvent.click(screen.getByTestId('notif-rule-dsr-draft'));
    await waitFor(() => expect(loadPrefs().rules['dsr-draft']).toBe(false));
  });

  it('clamps thresholds to their safe ranges', async () => {
    render(<NotificationsCard />);
    fireEvent.change(screen.getByTestId('notif-due-soon'), { target: { value: '99' } });
    fireEvent.change(screen.getByTestId('notif-dsr-stale'), { target: { value: '0' } });
    fireEvent.change(screen.getByTestId('notif-backup-stale'), { target: { value: '-5' } });

    await waitFor(() => {
      const prefs = loadPrefs();
      expect(prefs.dueSoonDays).toBe(30);
      expect(prefs.dsrStaleDays).toBe(1);
      expect(prefs.backupStaleDays).toBe(1);
    });
  });

  it('persists the toast switch', async () => {
    render(<NotificationsCard />);
    fireEvent.click(screen.getByTestId('notif-toasts'));
    await waitFor(() => expect(loadPrefs().toasts).toBe(false));
  });

  it('resets every preference to its default', async () => {
    render(<NotificationsCard />);
    fireEvent.click(screen.getByTestId('notif-master'));
    fireEvent.click(screen.getByTestId('notif-rule-dsr-draft'));
    await waitFor(() => expect(loadPrefs().enabled).toBe(false));

    fireEvent.click(screen.getByTestId('notif-reset'));
    await waitFor(() => {
      const prefs = loadPrefs();
      expect(prefs.enabled).toBe(true);
      expect(prefs.rules['dsr-draft']).toBe(true);
      expect(prefs.rules['boq-nearly']).toBe(false);
      expect(prefs.dueSoonDays).toBe(7);
    });
  });

  it('keeps preferences per job', async () => {
    render(<NotificationsCard />);
    fireEvent.click(screen.getByTestId('notif-master'));
    await waitFor(() => expect(loadPrefs().enabled).toBe(false));

    setActiveProject('PRJ-002');
    expect(loadPrefs().enabled).toBe(true);
    setActiveProject('PRJ-001');
    expect(loadPrefs().enabled).toBe(false);
  });

  it('disables the rule switches while the master switch is off', async () => {
    render(<NotificationsCard />);
    fireEvent.click(screen.getByTestId('notif-master'));
    await waitFor(() =>
      expect((screen.getByTestId('notif-rule-dsr-draft') as HTMLInputElement).disabled).toBe(true)
    );
  });
});
