// @vitest-environment jsdom
// Project identity must live in ONE place (the Projects master), and the page
// must never rewrite `contractoros_settings` — the fiscal year and payroll's
// wageUnpaidDays live there.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import SettingsPage from './Settings';
import { seedSignedInUser, TEST_PASSCODE } from '../testUtils/seedAuth';
import { DialogHost } from '../components/ui/DialogHost';
import { upsertProject } from '../services/masterData';

beforeEach(() => localStorage.clear());

describe('Settings', () => {
  it('has one project editor, not a second dead "Project Settings" form', () => {
    render(<SettingsPage timezone="Asia/Kathmandu" setTimezone={() => {}} />);

    expect(screen.queryByText('Project Settings')).toBeNull();
    expect(screen.queryByLabelText('Project Name')).toBeNull();
    expect(screen.queryByLabelText('Project Code')).toBeNull();
    expect(screen.queryByText(/Conversion Note/i)).toBeNull();

    expect(screen.getByLabelText('New project job number')).toBeTruthy();
    expect(screen.getByLabelText('New project name')).toBeTruthy();
    expect(screen.getByLabelText('Timezone')).toBeTruthy();
  });

  it('changing the timezone leaves company settings untouched', () => {
    localStorage.setItem('contractoros_settings', JSON.stringify({ fiscalYearStartMonth: 4, wageUnpaidDays: 10 }));
    const setTimezone = vi.fn();

    render(<SettingsPage timezone="Asia/Kathmandu" setTimezone={setTimezone} />);
    fireEvent.change(screen.getByLabelText('Timezone'), { target: { value: 'UTC' } });

    expect(setTimezone).toHaveBeenCalledWith('UTC');
    expect(JSON.parse(localStorage.getItem('contractoros_settings')!)).toEqual({
      fiscalYearStartMonth: 4,
      wageUnpaidDays: 10,
    });
  });

  it('offers a manual backup and a restore from a backup zip', () => {
    render(<SettingsPage timezone="Asia/Kathmandu" setTimezone={() => {}} />);

    expect(screen.getByTestId('backup-now')).toBeTruthy();
    expect(screen.getByTestId('restore-file')).toBeTruthy();
  });

  it('deletes a project only after the passcode is confirmed', async () => {
    await seedSignedInUser();
    // the app no longer seeds a job, so the test creates the one it deletes
    upsertProject({ id: 'PRJ-001', name: 'First job', client: '', status: 'active', startDate: '', endDate: '' });
    render(
      <>
        <SettingsPage timezone="Asia/Kathmandu" setTimezone={() => {}} />
        <DialogHost />
      </>
    );

    fireEvent.click(screen.getByLabelText('Remove PRJ-001'));
    // the dialog is real UI, not window.confirm (which is absent in the desktop app),
    // and it asks for the account secret before deleting data
    const dialog = await screen.findByTestId('destroy-dialog');
    fireEvent.change(within(dialog).getByTestId('destroy-secret'), { target: { value: TEST_PASSCODE } });
    fireEvent.click(within(dialog).getByTestId('destroy-confirm'));

    await waitFor(() => expect(screen.queryByLabelText('Contract value PRJ-001')).toBeNull());
    expect(screen.getByLabelText('New project job number')).toBeTruthy();
  });

  it('adds a job and makes it the active workspace', () => {
    render(<SettingsPage timezone="Asia/Kathmandu" setTimezone={() => {}} />);

    fireEvent.change(screen.getByLabelText('New project job number'), { target: { value: 'PRJ-777' } });
    fireEvent.change(screen.getByLabelText('New project name'), { target: { value: 'Hill Road' } });
    fireEvent.click(screen.getByText('Add project'));

    expect(localStorage.getItem('contractoros_active_project')).toBe('PRJ-777');
    expect(screen.getByLabelText('Contract value PRJ-777')).toBeTruthy();
  });
});
