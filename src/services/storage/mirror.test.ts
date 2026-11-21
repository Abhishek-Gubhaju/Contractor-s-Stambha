// @vitest-environment jsdom
// The durable mirror must mirror only business data, never write unless
// something changed, and restore through the same guarded path as a backup.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../backup/desktop', () => ({
  isDesktopApp: () => true,
  writeMirrorNative: vi.fn(),
  mirrorStatusNative: vi.fn(),
  readMirrorNative: vi.fn(),
}));
vi.mock('../auth/authService', () => ({
  activeUser: vi.fn(),
}));

import { activeUser } from '../auth/authService';
import { readMirrorNative, writeMirrorNative } from '../backup/desktop';
import { checksumOf } from '../backup/backupService';
import {
  buildMirrorPayload,
  collectMirrorKeys,
  flushMirror,
  isMirroredKey,
  MIRROR_UPDATED_EVENT,
  pushMirrorNow,
  scheduleMirrorPush,
  restoreFromMirror,
  type MirrorPayload,
} from './mirror';

const user = { id: 'usr-a', username: 'alex', displayName: 'Alex G.' };
const write = vi.mocked(writeMirrorNative);
const read = vi.mocked(readMirrorNative);
const me = vi.mocked(activeUser);

const payloadFor = (keys: Record<string, string>, overrides: Partial<MirrorPayload> = {}): MirrorPayload => ({
  app: 'contractorOS',
  kind: 'live-mirror',
  version: 1,
  savedAt: '2026-11-14T10:00:00.000Z',
  user,
  keys,
  checksum: checksumOf(JSON.stringify(keys)),
  ...overrides,
});

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  me.mockReturnValue(user as unknown as ReturnType<typeof activeUser>);
  write.mockResolvedValue({ saved_at: '', bytes: 0, keys: 0, username: 'alex' });
});

describe('what the mirror holds', () => {
  it('accepts business keys and refuses credentials or bookkeeping', () => {
    expect(isMirroredKey('contractoros_boq::PRJ-001')).toBe(true);
    expect(isMirroredKey('contractoros_ledger_attachments')).toBe(true);
    expect(isMirroredKey('contractoros_auth_users')).toBe(false);
    expect(isMirroredKey('contractoros_last_backup')).toBe(false);
    expect(isMirroredKey('contractoros_auto_backup')).toBe(false);
    expect(isMirroredKey('darkMode')).toBe(false);
  });

  it('collects exactly the restorable data the app can see', () => {
    localStorage.setItem('contractoros_boq::PRJ-001', '[]');
    localStorage.setItem('contractoros_auth_session', '{"id":"x"}');
    localStorage.setItem('contractoros_last_backup', '{}');
    localStorage.setItem('darkMode', 'true');

    expect(Object.keys(collectMirrorKeys())).toEqual(['contractoros_boq::PRJ-001']);
    const payload = buildMirrorPayload()!;
    expect(payload.user).toEqual(user);
    expect(payload.checksum).toBe(checksumOf(JSON.stringify(payload.keys)));
  });

  it('has nothing to mirror when nobody is signed in', () => {
    me.mockReturnValue(null);
    expect(buildMirrorPayload()).toBeNull();
    expect(collectMirrorKeys()).toEqual({});
  });
});

describe('pushing the mirror', () => {
  it('writes once and skips an unchanged snapshot', async () => {
    localStorage.setItem('contractoros_boq::PRJ-001', '[]');

    const first = await pushMirrorNow();
    expect(first.skipped).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe('usr-a');

    const second = await pushMirrorNow();
    expect(second).toEqual({ skipped: true, reason: 'unchanged' });
    expect(write).toHaveBeenCalledTimes(1);

    localStorage.setItem('contractoros_boq::PRJ-001', '[{"id":"new"}]');
    const third = await pushMirrorNow();
    expect(third.skipped).toBe(false);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('reports a write failure instead of throwing', async () => {
    localStorage.setItem('contractoros_boq::PRJ-001', '[{"id":"fail-case"}]');
    write.mockRejectedValue(new Error('disk full'));
    const outcome = await pushMirrorNow();
    expect(outcome.skipped).toBe(true);
    expect(outcome.reason).toBe('failed');
    expect(outcome.error).toMatch(/disk full/);
  });

  it('does not write an empty mirror', async () => {
    const outcome = await pushMirrorNow();
    expect(outcome).toEqual({ skipped: true, reason: 'empty' });
    expect(write).not.toHaveBeenCalled();
  });

  it('does no serialisation work on a flush when nothing was saved', async () => {
    localStorage.setItem('contractoros_boq::PRJ-001', '[{"id":"clean-flush"}]');
    await pushMirrorNow();
    expect(write).toHaveBeenCalledTimes(1);

    const flushed = await flushMirror();
    expect(flushed).toEqual({ skipped: true, reason: 'unchanged' });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('announces a landed write so open screens can refresh', async () => {
    const heard = vi.fn();
    window.addEventListener(MIRROR_UPDATED_EVENT, heard);
    try {
      localStorage.setItem('contractoros_boq::PRJ-001', '[{"id":"announce"}]');
      await pushMirrorNow();
      expect(heard).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(MIRROR_UPDATED_EVENT, heard);
    }
  });

  it('a save that lands during a write is not marked clean', async () => {
    localStorage.setItem('contractoros_boq::PRJ-001', '[{"id":"race-1"}]');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    write.mockImplementationOnce(async () => {
      await gate;
      return { saved_at: '', bytes: 0, keys: 0, username: 'alex' };
    });

    const pending = pushMirrorNow();
    // A real save arrives while the first native write is still in flight.
    localStorage.setItem('contractoros_boq::PRJ-001', '[{"id":"race-2"}]');
    scheduleMirrorPush(0);
    release();
    await pending;

    const flushed = await flushMirror();
    expect(flushed.skipped).toBe(false);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][1]).toContain('race-2');
  });

  it('writes for a newly signed-in account even when its data is identical', async () => {
    localStorage.setItem('contractoros_boq::PRJ-001', '[{"id":"shared-shape"}]');
    expect((await pushMirrorNow()).skipped).toBe(false);
    expect(write.mock.calls[0][0]).toBe('usr-a');

    // Same data, different account: the mirror belongs to the new account and
    // must be written, not skipped because the bytes match the previous one.
    me.mockReturnValue({ ...user, id: 'usr-b', username: 'asha', displayName: 'Asha Rai' } as unknown as ReturnType<typeof activeUser>);
    const second = await pushMirrorNow();
    expect(second.skipped).toBe(false);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][0]).toBe('usr-b');
  });
});

describe('restoring from the mirror', () => {
  it('puts the mirrored data back, keeping anything newer', async () => {
    localStorage.setItem('contractoros_boq::PRJ-001', '[{"id":"newer"}]');
    localStorage.setItem('contractoros_dsr::PRJ-009', '[{"id":"other-job"}]');
    read.mockResolvedValue(JSON.stringify(payloadFor({ 'contractoros_boq::PRJ-001': '[{"id":"mirrored"}]' })));

    const result = await restoreFromMirror('current');
    expect(result.restored).toBe(1);
    expect(localStorage.getItem('contractoros_boq::PRJ-001')).toBe('[{"id":"mirrored"}]');
    // Merge semantics: a key the mirror never held is not deleted.
    expect(localStorage.getItem('contractoros_dsr::PRJ-009')).toBe('[{"id":"other-job"}]');
    // A safety copy exists for undo.
    expect(JSON.parse(localStorage.getItem('contractoros_pre_restore')!).values['contractoros_boq::PRJ-001']).toBe(
      '[{"id":"newer"}]'
    );
  });

  it('restores the previous version when asked for it', async () => {
    read.mockResolvedValue(JSON.stringify(payloadFor({ 'contractoros_boq::PRJ-001': '[{"id":"older"}]' })));
    await restoreFromMirror('previous');
    expect(read).toHaveBeenCalledWith('usr-a', 'previous');
    expect(localStorage.getItem('contractoros_boq::PRJ-001')).toBe('[{"id":"older"}]');
  });

  it('refuses another account’s mirror', async () => {
    read.mockResolvedValue(
      JSON.stringify(payloadFor({ 'contractoros_boq::PRJ-001': '[]' }, { user: { ...user, id: 'usr-b', username: 'asha' } }))
    );
    await expect(restoreFromMirror('current')).rejects.toThrow(/another account/i);
    expect(localStorage.getItem('contractoros_boq::PRJ-001')).toBeNull();
  });

  it('refuses a mirror whose data no longer matches its checksum', async () => {
    const payload = payloadFor({ 'contractoros_boq::PRJ-001': '[{"id":"a"}]' });
    payload.keys['contractoros_boq::PRJ-001'] = '[{"id":"tampered"}]';
    read.mockResolvedValue(JSON.stringify(payload));
    await expect(restoreFromMirror('current')).rejects.toThrow(/damaged/i);
    expect(localStorage.getItem('contractoros_boq::PRJ-001')).toBeNull();
  });

  it('refuses a mirror with no checksum at all', async () => {
    const payload = payloadFor({ 'contractoros_boq::PRJ-001': '[]' });
    delete (payload as Partial<MirrorPayload>).checksum;
    read.mockResolvedValue(JSON.stringify(payload));
    await expect(restoreFromMirror('current')).rejects.toThrow(/damaged/i);
  });

  it('refuses a file that is not a mirror at all', async () => {
    read.mockResolvedValue('{"hello":"world"}');
    await expect(restoreFromMirror('current')).rejects.toThrow(/not a Stambha live mirror/i);
  });

  it('refuses a newer format', async () => {
    read.mockResolvedValue(JSON.stringify(payloadFor({ 'contractoros_boq::PRJ-001': '[]' }, { version: 99 })));
    await expect(restoreFromMirror('current')).rejects.toThrow(/newer Stambha/i);
  });
});
