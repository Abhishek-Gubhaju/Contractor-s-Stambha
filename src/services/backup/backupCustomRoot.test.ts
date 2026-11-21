// @vitest-environment jsdom
// The chosen folder must be handed to every native backup command, and the
// default (null) must stay in place when nothing was chosen.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./desktop', () => ({
  isDesktopApp: () => true,
  saveBackupFilesNative: vi.fn(async () => '/Volumes/Backups/Stambha'),
  listBackupRunsNative: vi.fn(async () => []),
  readBackupRunNative: vi.fn(async () => ({ manifest: '{}', files: [] })),
}));

import { listLocalBackups, runBackup } from './backupService';
import { loadBackupLocation, saveBackupLocation } from './backupLocation';
import { saveBackupFilesNative, listBackupRunsNative } from './desktop';

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe('custom backup folder', () => {
  it('passes the chosen folder and reports the folder actually written', async () => {
    saveBackupLocation('/Volumes/Backups');
    const result = await runBackup();

    expect(saveBackupFilesNative).toHaveBeenCalledTimes(1);
    const [files, root] = (saveBackupFilesNative as any).mock.calls[0];
    expect(Array.isArray(files)).toBe(true);
    expect(root).toBe('/Volumes/Backups');
    expect(result.mode).toBe('desktop');
    expect(result.location).toBe('/Volumes/Backups/Stambha');
  });

  it('keeps the default when no folder was chosen', async () => {
    await runBackup();
    const [, root] = (saveBackupFilesNative as any).mock.calls[0];
    expect(root).toBeNull();
    expect(loadBackupLocation()).toBeNull();
  });

  it('lists saved runs from the chosen folder', async () => {
    saveBackupLocation('~/Backups');
    await listLocalBackups();
    expect(listBackupRunsNative).toHaveBeenCalledTimes(1);
    expect((listBackupRunsNative as any).mock.calls[0][1]).toBe('~/Backups');
  });
});
