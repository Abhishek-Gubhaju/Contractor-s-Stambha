// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const chooseBackupFolder = vi.fn<() => Promise<string | null>>(async () => '/Volumes/Backups');

vi.mock('../services/backup/desktop', () => ({
  isDesktopApp: () => true,
  chooseBackupFolderNative: () => chooseBackupFolder(),
  revealBackupFolder: vi.fn(),
  saveBackupFilesNative: vi.fn(async () => '/Volumes/Backups/Stambha'),
  listBackupRunsNative: vi.fn(async () => []),
  readBackupRunNative: vi.fn(async () => ({ manifest: '{}', files: [] })),
  quitApp: vi.fn(),
  markClosePromptReady: vi.fn(),
  writeMirrorNative: vi.fn(async () => ({ saved_at: '', bytes: 0, keys: 0, username: null })),
  mirrorStatusNative: vi.fn(async () => ({ current: null, previous: null, folder: '' })),
  readMirrorNative: vi.fn(async () => '{}'),
}));

import SettingsPage from './Settings';
import { DialogHost } from '../components/ui/DialogHost';
import { BACKUP_LOCATION_KEY } from '../services/backup/backupLocation';

beforeEach(() => {
  localStorage.clear();
  chooseBackupFolder.mockReset();
  chooseBackupFolder.mockResolvedValue('/Volumes/Backups');
});

const renderSettings = () =>
  render(
    <>
      <SettingsPage timezone="Asia/Kathmandu" setTimezone={() => {}} />
      <DialogHost />
    </>
  );

describe('backup folder setting', () => {
  it('saves the folder chosen with the native picker and shows it as current', async () => {
    renderSettings();
    fireEvent.click(screen.getByTestId('backup-location-choose'));

    await waitFor(() => expect(localStorage.getItem(BACKUP_LOCATION_KEY)).toBe('/Volumes/Backups'));
    expect(screen.getByTestId('backup-location-current').textContent).toContain('/Volumes/Backups');
    expect(screen.getByTestId('backup-location-msg').textContent).toMatch(/saved there/i);
  });

  it('keeps the current folder when the picker is dismissed', async () => {
    chooseBackupFolder.mockResolvedValueOnce(null);
    renderSettings();
    fireEvent.click(screen.getByTestId('backup-location-choose'));

    await waitFor(() => expect(chooseBackupFolder).toHaveBeenCalled());
    expect(localStorage.getItem(BACKUP_LOCATION_KEY)).toBeNull();
    expect(screen.getByTestId('backup-location-current').textContent).toContain('Documents/Stambha');
  });

  it('refuses a relative path and keeps the old folder', async () => {
    chooseBackupFolder.mockResolvedValueOnce('Backups');
    renderSettings();
    fireEvent.click(screen.getByTestId('backup-location-choose'));

    await waitFor(() => expect(screen.getByTestId('backup-location-msg').textContent).toMatch(/absolute/i));
    expect(localStorage.getItem(BACKUP_LOCATION_KEY)).toBeNull();
    expect(screen.getByTestId('backup-location-current').textContent).toContain('Documents/Stambha');
  });

  it('resets to the default folder', async () => {
    localStorage.setItem(BACKUP_LOCATION_KEY, '/Volumes/Backups');
    renderSettings();
    expect(screen.getByTestId('backup-location-current').textContent).toContain('/Volumes/Backups');

    fireEvent.click(screen.getByTestId('backup-location-reset'));

    await waitFor(() => expect(localStorage.getItem(BACKUP_LOCATION_KEY)).toBeNull());
    expect(screen.getByTestId('backup-location-current').textContent).toContain('Documents/Stambha');
    expect(screen.queryByTestId('backup-location-reset')).toBeNull();
  });
});
