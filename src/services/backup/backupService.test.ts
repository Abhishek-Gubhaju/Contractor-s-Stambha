// @vitest-environment jsdom
// Backups must land under Stambha/<project>/<feature>, carry a manifest that
// maps every file back to its storage key, and never restore derived exports.
import { describe, it, expect, beforeEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  BACKUP_ROOT,
  BACKUP_FORMAT_VERSION,
  COMPANY_FOLDER,
  buildBackup,
  checksumOf,
  pendingRestore,
  projectFolder,
  runStamp,
  restoreFromFiles,
  sanitizeSegment,
  undoLastRestore,
  restoreFromZip,
  zipBackup,
} from './backupService';
import { scopedKey, setActiveProject } from '../projectScope';
import { upsertProject } from '../masterData';
import { upsertCommitment } from '../commitments';
import { createUser, startSession } from '../auth/authService';

// jsdom has no SubtleCrypto; account creation needs it for hashing.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

const seed = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  upsertProject({ id: 'PRJ-001', name: 'Sample Commercial Complex', client: '', status: 'active', startDate: '', endDate: '' });
  upsertProject({ id: 'PRJ-002', name: 'Hill / Road: Phase 2', client: '', status: 'active', startDate: '', endDate: '' });
  setActiveProject('PRJ-001');
});

describe('layout', () => {
  it('sanitises folder names', () => {
    expect(sanitizeSegment('Hill / Road: Phase 2')).toBe('Hill-Road-Phase-2');
    expect(sanitizeSegment('   ')).toBe('untitled');
    expect(projectFolder({ id: 'PRJ-002', name: 'Hill / Road', client: '', status: 'active', startDate: '', endDate: '' }))
      .toBe('PRJ-002_Hill-Road');
  });

  it('writes one folder per project and feature, and a manifest', () => {
    seed(scopedKey('contractoros_boq', 'PRJ-001'), [{ id: 's', children: [{ itemCode: 'A.01', amount: 100 }] }]);
    seed(scopedKey('contractoros_boq', 'PRJ-002'), [{ id: 's2', children: [] }]);
    seed('contractoros_settings', { fiscalYearStartMonth: 4 });

    const now = new Date('2026-03-04T05:06:07Z');
    const { files, manifest, runId: stamp } = buildBackup(now);
    const paths = files.map((f) => f.path);

    expect(paths).toContain(`${BACKUP_ROOT}/PRJ-001_Sample-Commercial-Complex/BOQ/boq-${stamp}.json`);
    expect(paths).toContain(`${BACKUP_ROOT}/PRJ-002_Hill-Road-Phase-2/BOQ/boq-${stamp}.json`);
    // Company/letterhead settings belong to the job that prints them.
    expect(paths).toContain(`${BACKUP_ROOT}/PRJ-001_Sample-Commercial-Complex/Settings/company-settings-${stamp}.json`);
    expect(paths).toContain(`${BACKUP_ROOT}/manifest-${stamp}.json`);
    expect(paths).toContain(`${BACKUP_ROOT}/latest-manifest.json`);
    expect(manifest.projects.map((p) => p.id)).toEqual(['PRJ-001', 'PRJ-002']);
    expect(manifest.totals.files).toBe(files.length);
  });
});

describe('one folder per person', () => {
  const identity = { id: 'usr-a', username: 'alex', displayName: 'Alex G.' };

  it('writes under Stambha/<username>/ when an account is signed in', () => {
    seed(scopedKey('contractoros_boq', 'PRJ-001'), [{ id: 's', children: [{ itemCode: 'A.01', amount: 100 }] }]);
    seed('contractoros_settings', { fiscalYearStartMonth: 4 });
    const now = new Date('2026-03-04T05:06:07Z');
    const { files, manifest, runId: stamp } = buildBackup(now, identity);
    const paths = files.map((f) => f.path);

    expect(paths).toContain(`${BACKUP_ROOT}/alex/PRJ-001_Sample-Commercial-Complex/BOQ/boq-${stamp}.json`);
    expect(paths).toContain(`${BACKUP_ROOT}/alex/PRJ-001_Sample-Commercial-Complex/Settings/company-settings-${stamp}.json`);
    expect(paths).toContain(`${BACKUP_ROOT}/alex/latest-manifest.json`);
    expect(manifest.user).toEqual(identity);
  });

  it('refuses to restore one account’s backup into another account', async () => {
    seed(scopedKey('contractoros_boq', 'PRJ-001'), [{ id: 's', children: [] }]);
    const { files, manifest } = buildBackup(new Date(), identity);
    const contents = Object.fromEntries(files.map((f) => [f.path, f.content]));

    const other = await createUser({ username: 'asha', password: 'Site-Office-2026' });
    startSession(other);
    expect(() => restoreFromFiles(contents, manifest)).toThrow(/belongs to @alex/i);
  });
});

describe('project slices', () => {
  it('puts only that job’s commitments and ledger in its folder', () => {
    upsertCommitment({ ref: 'PO-1', vendor: 'A', project_id: 'PRJ-001', amount: 500, status: 'approved' });
    setActiveProject('PRJ-002');
    upsertCommitment({ ref: 'PO-2', vendor: 'B', project_id: 'PRJ-002', amount: 900, status: 'approved' });
    setActiveProject('PRJ-001');
    seed(scopedKey('contractoros_entries', 'PRJ-001'), [{ id: 'e1', date: '2026-01-01', type: 'expense-paid' }]);
    seed(scopedKey('contractoros_entries', 'PRJ-002'), [{ id: 'e2', date: '2026-01-02', type: 'expense-paid' }]);
    seed(scopedKey('contractoros_entry_lines', 'PRJ-001'), [
      { id: 'l1', entry_id: 'e1', project_id: 'PRJ-001', account_id: 'acc:x', debit: 100 },
    ]);
    seed(scopedKey('contractoros_entry_lines', 'PRJ-002'), [
      { id: 'l2', entry_id: 'e2', project_id: 'PRJ-002', account_id: 'acc:x', debit: 200 },
    ]);

    const { files } = buildBackup();
    const find = (p: string) => files.find((f) => f.path.includes(p))!;

    const p1Commitments = JSON.parse(find('PRJ-001_Sample-Commercial-Complex/Commitments/commitments-').content);
    expect(p1Commitments).toHaveLength(1);
    expect(p1Commitments[0].ref).toBe('PO-1');

    const p2Commitments = JSON.parse(find('PRJ-002_Hill-Road-Phase-2/Commitments/commitments-').content);
    expect(p2Commitments).toHaveLength(1);
    expect(p2Commitments[0].ref).toBe('PO-2');

    const p2Lines = JSON.parse(find('PRJ-002_Hill-Road-Phase-2/Ledger/entry-lines-').content);
    expect(p2Lines).toHaveLength(1);
    expect(p2Lines[0].project_id).toBe('PRJ-002');

    const p1Entries = JSON.parse(find('PRJ-001_Sample-Commercial-Complex/Ledger/entries-').content);
    expect(p1Entries.map((e: any) => e.id)).toEqual(['e1']);
  });

  it('treats each job’s ledger files as authoritative and restorable', () => {
    seed('contractoros_boq', [{ id: 's', children: [] }]);
    seed(scopedKey('contractoros_entry_lines', 'PRJ-001'), [{ id: 'l1', entry_id: 'e1', project_id: 'PRJ-001', debit: 5 }]);
    const { manifest } = buildBackup();
    const ledger = manifest.files.filter((f) => f.path.includes('/Ledger/entry-lines-'));
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger.every((f) => f.restorable === true)).toBe(true);
  });
});

describe('restore', () => {
  it('writes files back to the keys and scope recorded in the manifest', () => {
    seed(scopedKey('contractoros_boq', 'PRJ-001'), [{ id: 'old', children: [] }]);
    const { files, manifest } = buildBackup();
    const contents = Object.fromEntries(files.map((f) => [f.path, f.content]));

    // change the live document, then restore
    seed(scopedKey('contractoros_boq', 'PRJ-001'), [{ id: 'edited', children: [] }]);
    const result = restoreFromFiles(contents, manifest);

    expect(result.restored).toBeGreaterThan(0);
    const boq = JSON.parse(localStorage.getItem(scopedKey('contractoros_boq', 'PRJ-001'))!);
    expect(boq[0].id).toBe('old');
    // a safety copy of the pre-restore state is kept
    expect(localStorage.getItem('contractoros_pre_restore')).toContain('edited');
  });

  it('round-trips entry attachments, so scans survive a new machine', () => {
    const path = 'data/ledger/attachments/bill-45.png';
    const attachKey = scopedKey('contractoros_ledger_attachments', 'PRJ-001');
    seed(attachKey, { [path]: 'data:image/png;base64,AAAA' });
    const { files, manifest } = buildBackup();
    expect(files.some((f) => f.path.includes('/Ledger/attachments-'))).toBe(true);

    const contents = Object.fromEntries(files.map((f) => [f.path, f.content]));
    localStorage.removeItem(attachKey);
    restoreFromFiles(contents, manifest);

    const store = JSON.parse(localStorage.getItem(attachKey) || '{}');
    expect(store[path]).toBe('data:image/png;base64,AAAA');
  });

  it('round-trips a daily report with its vault links', () => {
    const dsrKey = scopedKey('contractoros_dsr', 'PRJ-001');
    seed(dsrKey, [
      {
        id: 'dsr-1',
        reportNo: 'DSR-2082/83-001',
        date: '2026-01-10',
        project_id: 'PRJ-001',
        items: [],
        status: 'draft',
        attachments: [
          { id: 'doc-1', name: 'slab.pdf', ext: 'pdf', sizeBytes: 3, addedAt: '2026-01-10T08:00:00.000Z' },
        ],
      },
    ]);
    const { files, manifest } = buildBackup();
    expect(files.some((f) => f.path.includes('/DSR/dsr-'))).toBe(true);

    const contents = Object.fromEntries(files.map((f) => [f.path, f.content]));
    localStorage.removeItem(dsrKey);
    restoreFromFiles(contents, manifest);

    const restored = JSON.parse(localStorage.getItem(dsrKey)!);
    expect(restored[0].attachments[0]).toMatchObject({ id: 'doc-1', name: 'slab.pdf' });
  });

  it('restores one job’s ledger into that job’s scoped key', () => {
    const linesKey = scopedKey('contractoros_entry_lines', 'PRJ-001');
    seed(linesKey, [{ id: 'l1', entry_id: 'e1', project_id: 'PRJ-001', debit: 5 }]);
    const { files, manifest } = buildBackup();
    const contents = Object.fromEntries(files.map((f) => [f.path, f.content]));
    localStorage.removeItem(linesKey);
    const result = restoreFromFiles(contents, manifest);
    expect(result.restored).toBeGreaterThan(0);
    expect(JSON.parse(localStorage.getItem(linesKey)!)[0].id).toBe('l1');
  });
});

describe('what a backup contains', () => {
  it('includes the company profile, parties and document line items', () => {
    seed('contractoros_company', { name: 'Example Constructions', pan: '123456789' });
    seed('contractoros_parties', [{ id: 'p1', name: 'Nepal Bank', type: 'client' }]);
    seed('contractoros_entry_items', [{ id: 'di1', description: 'Cement', amount: 5000 }]);

    const { files } = buildBackup();
    const paths = files.map((f) => f.path);
    expect(paths.some((p) => p.includes('/Settings/company-profile-'))).toBe(true);
    expect(paths.some((p) => p.includes('/Masters/parties-'))).toBe(true);
    expect(paths.some((p) => p.includes('/Billing/document-items-'))).toBe(true);
  });

  it('records a checksum and true byte size for every file', () => {
    seed(scopedKey('contractoros_boq', 'PRJ-001'), [{ id: 's', children: [], note: 'काठमाडौं' }]);
    const { files, manifest } = buildBackup();
    const boq = manifest.files.find((f) => f.key === 'contractoros_boq')!;
    const content = files.find((f) => f.path === boq.path)!.content;
    expect(boq.checksum).toBe(checksumOf(content));
    expect(boq.bytes).toBe(new TextEncoder().encode(content).length);
    expect(boq.bytes).toBeGreaterThan(content.length); // UTF-8, not UTF-16 units
  });

  it('counts exactly the files it wrote, manifests included', () => {
    seed('contractoros_settings', { fiscalYearStartMonth: 4 });
    const { files, manifest } = buildBackup();
    expect(manifest.totals.files).toBe(files.length);
    expect(manifest.totals.bytes).toBe(
      files.reduce((sum, file) => sum + new TextEncoder().encode(file.content).length, 0)
    );
  });

  it('never reuses a run id, even for two backups at the same instant', () => {
    const now = new Date('2026-03-04T05:06:07.123Z');
    const first = buildBackup(now).runId;
    const second = buildBackup(now).runId;
    expect(first).not.toBe(second);
    expect(runStamp(new Date('2026-03-04T05:06:07.123Z'))).toMatch(/^\d{8}-\d{6}-\d{3}$/);
  });
});

describe('restore safety', () => {
  const manifestFor = (manifest: any, files: any[]) => ({ ...manifest, files });

  it('refuses a manifest that tries to write credentials', () => {
    seed('contractoros_boq', [{ id: 's', children: [] }]);
    const { manifest } = buildBackup();
    const forged = manifestFor({ ...manifest, files: [] }, [
      {
        path: 'evil.json',
        key: 'contractoros_auth_users',
        restorable: true,
        bytes: 20,
        count: 1,
      },
    ]);
    const before = localStorage.getItem('contractoros_auth_users');
    expect(() => restoreFromFiles({ 'evil.json': '[{"admin":true}]' }, forged)).toThrow(/no restorable/i);
    expect(localStorage.getItem('contractoros_auth_users')).toBe(before);
  });

  it('reports ignored keys but still restores the legitimate ones', () => {
    seed('contractoros_boq', [{ id: 'new', children: [] }]);
    const { files, manifest } = buildBackup();
    const contents = Object.fromEntries(files.map((f) => [f.path, f.content]));
    contents['evil.json'] = '[]';
    const tampered = manifestFor(manifest, [
      ...manifest.files,
      { path: 'evil.json', key: 'contractoros_auth_session', restorable: true, bytes: 2, count: 0 },
    ]);
    const result = restoreFromFiles(contents, tampered);
    expect(result.ignoredKeys).toContain('contractoros_auth_session');
    expect(result.restored).toBeGreaterThan(0);
  });

  it('refuses a file whose checksum no longer matches', () => {
    seed('contractoros_boq', [{ id: 'good', children: [] }]);
    const { files, manifest } = buildBackup();
    const contents = Object.fromEntries(files.map((f) => [f.path, f.content]));
    const boq = manifest.files.find((f) => f.key === 'contractoros_boq')!;
    contents[boq.path] = JSON.stringify([{ id: 'tampered', children: [] }]);
    expect(() => restoreFromFiles(contents, manifest)).toThrow(/damaged/i);
    // Nothing was written.
    expect(JSON.parse(localStorage.getItem('contractoros_boq')!)[0].id).toBe('good');
  });

  it('refuses an incomplete backup instead of restoring part of it', () => {
    seed('contractoros_boq', [{ id: 'x', children: [] }]);
    const { files, manifest } = buildBackup();
    const contents = Object.fromEntries(files.map((f) => [f.path, f.content]));
    const boq = manifest.files.find((f) => f.key === 'contractoros_boq')!;
    delete contents[boq.path];
    expect(() => restoreFromFiles(contents, manifest)).toThrow(/incomplete/i);
  });

  it('refuses a backup from a newer app version', () => {
    seed('contractoros_boq', [{ id: 'x', children: [] }]);
    const { files, manifest } = buildBackup();
    const contents = Object.fromEntries(files.map((f) => [f.path, f.content]));
    expect(() => restoreFromFiles(contents, { ...manifest, version: BACKUP_FORMAT_VERSION + 5 })).toThrow(/newer/i);
  });

  it('refuses a backup with nothing restorable in it', () => {
    const { manifest } = buildBackup();
    expect(() => restoreFromFiles({}, { ...manifest, files: [] })).toThrow(/no restorable/i);
  });

  it('replaces a project exactly: data missing from the backup is removed', () => {
    seed(scopedKey('contractoros_boq', 'PRJ-001'), [{ id: 'kept', children: [] }]);
    const { files, manifest } = buildBackup();
    const contents = Object.fromEntries(files.map((f) => [f.path, f.content]));

    // Work added after the backup, plus a job created after the backup.
    seed(scopedKey('contractoros_milestones', 'PRJ-001'), [{ id: 'late' }]);
    upsertProject({ id: 'PRJ-003', name: 'Started later', client: '', status: 'active', startDate: '', endDate: '' });
    seed(scopedKey('contractoros_boq', 'PRJ-003'), [{ id: 'newer-job', children: [] }]);

    const result = restoreFromFiles(contents, manifest);
    expect(result.cleared).toBeGreaterThan(0);
    expect(localStorage.getItem(scopedKey('contractoros_milestones', 'PRJ-001'))).toBeNull();
    expect(JSON.parse(localStorage.getItem(scopedKey('contractoros_boq', 'PRJ-001'))!)[0].id).toBe('kept');
    // PRJ-002 was a known job when the backup was taken (with no BOQ), so its
    // later BOQ is part of what "restore to that moment" removes.
    seed(scopedKey('contractoros_boq', 'PRJ-002'), [{ id: 'later', children: [] }]);
    expect(() => restoreFromFiles(contents, manifest)).not.toThrow();
    expect(localStorage.getItem(scopedKey('contractoros_boq', 'PRJ-002'))).toBeNull();
    // A job created after the backup is outside its scope and is left alone.
    expect(JSON.parse(localStorage.getItem(scopedKey('contractoros_boq', 'PRJ-003'))!)[0].id).toBe('newer-job');
  });

  it('can be undone, putting back both replaced and removed data', () => {
    seed(scopedKey('contractoros_boq', 'PRJ-001'), [{ id: 'from-backup', children: [] }]);
    const { files, manifest } = buildBackup();
    const contents = Object.fromEntries(files.map((f) => [f.path, f.content]));

    seed(scopedKey('contractoros_boq', 'PRJ-001'), [{ id: 'current', children: [] }]);
    seed(scopedKey('contractoros_dsr', 'PRJ-001'), [{ id: 'late-report' }]);

    restoreFromFiles(contents, manifest);
    expect(pendingRestore()?.keys).toBeGreaterThan(0);
    expect(localStorage.getItem(scopedKey('contractoros_dsr', 'PRJ-001'))).toBeNull();

    const undone = undoLastRestore();
    expect(undone.reverted).toBeGreaterThan(0);
    expect(JSON.parse(localStorage.getItem(scopedKey('contractoros_boq', 'PRJ-001'))!)[0].id).toBe('current');
    expect(JSON.parse(localStorage.getItem(scopedKey('contractoros_dsr', 'PRJ-001'))!)[0].id).toBe('late-report');
    expect(pendingRestore()).toBeNull();
  });
});

describe('zip round trip', () => {
  it('restores exactly what a downloaded ZIP contains', async () => {
    seed(scopedKey('contractoros_boq', 'PRJ-001'), [{ id: 'from-zip', children: [] }]);
    const { files, manifest } = buildBackup();
    const zip = await zipBackup(files);
    const file = new File([zip], `Stambha-backup-${manifest.runId}.zip`, { type: 'application/zip' });

    localStorage.clear();
    const result = await restoreFromZip(file);
    expect(result.runId).toBe(manifest.runId);
    expect(result.restored).toBeGreaterThan(0);
    expect(JSON.parse(localStorage.getItem(scopedKey('contractoros_boq', 'PRJ-001'))!)[0].id).toBe('from-zip');
  });

  it('refuses a zip that is not a contractorOS backup', async () => {
    const zip = new (await import('jszip')).default();
    zip.file('holiday-photo.txt', 'not a backup');
    const blob = await zip.generateAsync({ type: 'blob' });
    await expect(restoreFromZip(new File([blob], 'random.zip'))).rejects.toThrow(/manifest/i);
  });
});
