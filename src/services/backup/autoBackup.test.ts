// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AUTO_BACKUP_KEY,
  backupIsDue,
  dataFingerprint,
  readAutoBackup,
  autoBackup,
} from './autoBackup';

beforeEach(() => localStorage.clear());

describe('auto backup fingerprint', () => {
  it('changes when business data changes and ignores auth bookkeeping', () => {
    localStorage.setItem('contractoros_boq::PRJ-001', '[]');
    const first = dataFingerprint();
    expect(first).toBeTruthy();

    // Signing in, writing a backup record or a toast marker is not new work.
    localStorage.setItem('contractoros_auth_session', '{"user":"x"}');
    localStorage.setItem('contractoros_last_backup', '{}');
    localStorage.setItem('contractoros_auto_backup', '{}');
    expect(dataFingerprint()).toBe(first);

    localStorage.setItem('contractoros_boq::PRJ-001', '[{"id":"new"}]');
    expect(dataFingerprint()).not.toBe(first);
  });

  it('treats a missing or corrupt record as “due”', () => {
    expect(readAutoBackup()).toBeNull();
    localStorage.setItem(AUTO_BACKUP_KEY, 'not json');
    expect(readAutoBackup()).toBeNull();
    expect(backupIsDue('fp', null, 1000)).toBe(true);
  });
});

describe('when a silent backup is allowed', () => {
  const record = { at: 1_000_000, fingerprint: 'fp', runId: '20260101-000000-000' };

  it('skips unchanged data', () => {
    expect(backupIsDue('fp', record, 1_000_000 + 10 * 60_000)).toBe(false);
  });

  it('waits out the quiet gap after a change', () => {
    expect(backupIsDue('different', record, record.at + 5_000)).toBe(false);
    expect(backupIsDue('different', record, record.at + 61_000)).toBe(true);
  });
});

describe('in a browser', () => {
  it('never writes a surprise backup', async () => {
    localStorage.setItem('contractoros_boq::PRJ-001', '[{"id":"a"}]');
    const outcome = await autoBackup();
    expect(outcome).toEqual({ skipped: true, reason: 'browser' });
  });
});
