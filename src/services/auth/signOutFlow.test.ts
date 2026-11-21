// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../components/ui/DialogHost', () => ({
  choiceDialog: vi.fn(),
  confirmDialog: vi.fn(),
  notify: vi.fn(),
}));
vi.mock('../backup/backupService', () => ({
  runBackup: vi.fn(),
}));
vi.mock('../backup/autoBackup', () => ({
  autoBackup: vi.fn(),
}));
vi.mock('../storage/mirror', () => ({
  flushMirror: vi.fn().mockResolvedValue({ skipped: true, reason: 'browser' }),
}));
vi.mock('./authService', () => ({
  signOut: vi.fn(),
}));

import { choiceDialog, confirmDialog } from '../../components/ui/DialogHost';
import { runBackup } from '../backup/backupService';
import { autoBackup } from '../backup/autoBackup';
import { signOut } from './authService';
import { expireSession, requestSignOut } from './signOutFlow';

const choice = vi.mocked(choiceDialog);
const confirm = vi.mocked(confirmDialog);
const backup = vi.mocked(runBackup);
const silent = vi.mocked(autoBackup);
const end = vi.mocked(signOut);

const result = { mode: 'desktop' as const, runId: 'r1', fileCount: 8, bytes: 100, location: 'Documents/Stambha' };

beforeEach(() => {
  vi.clearAllMocks();
  choice.mockResolvedValue(null);
  confirm.mockResolvedValue(false);
});

describe('requestSignOut', () => {
  it('stays signed in when the dialog is dismissed', async () => {
    expect(await requestSignOut()).toBe(false);
    expect(end).not.toHaveBeenCalled();
    expect(backup).not.toHaveBeenCalled();
  });

  it('treats the explicit cancel option as staying', async () => {
    choice.mockResolvedValue('cancel');
    expect(await requestSignOut()).toBe(false);
    expect(end).not.toHaveBeenCalled();
  });

  it('backs up first, then ends the session', async () => {
    choice.mockResolvedValue('backup');
    backup.mockResolvedValue(result);
    expect(await requestSignOut()).toBe(true);
    expect(backup).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledWith('manual');
  });

  it('signs out without a backup when that is chosen', async () => {
    choice.mockResolvedValue('without-backup');
    expect(await requestSignOut()).toBe(true);
    expect(backup).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledWith('manual');
  });

  it('keeps the session when the backup fails and the person stays', async () => {
    choice.mockResolvedValue('backup');
    backup.mockRejectedValue(new Error('disk full'));
    confirm.mockResolvedValue(false);
    expect(await requestSignOut()).toBe(false);
    expect(confirm).toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });

  it('still signs out after a failed backup if asked to', async () => {
    choice.mockResolvedValue('backup');
    backup.mockRejectedValue(new Error('disk full'));
    confirm.mockResolvedValue(true);
    expect(await requestSignOut()).toBe(true);
    expect(end).toHaveBeenCalledWith('manual');
  });
});

describe('expireSession', () => {
  it('takes a silent backup and expires the session without a dialog', async () => {
    silent.mockResolvedValue({ skipped: true, reason: 'unchanged' });
    await expireSession();
    expect(silent).toHaveBeenCalledTimes(1);
    expect(choice).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledWith('expired');
  });

  it('never lets a failed safety backup keep the session open', async () => {
    silent.mockRejectedValue(new Error('boom'));
    await expireSession();
    expect(end).toHaveBeenCalledWith('expired');
  });
});
