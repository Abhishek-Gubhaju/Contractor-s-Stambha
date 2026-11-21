// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertAttachable,
  cancelDsrUpload,
  dsrAttachmentNotes,
  dsrDateFolder,
  dsrFolderChain,
  dsrFolderLabel,
  dsrMonthFolder,
  dsrRootFolder,
  existingDsrFolderLabel,
  focusInVault,
  isDsrDate,
  mergeDsrAttachments,
  retargetDsrAttachments,
  takeVaultFocus,
  uploadDsrAttachments,
  withoutDsrAttachment,
} from './dsrAttachments';
import { blankReport, MAX_DSR_ATTACHMENTS, type DsrAttachment, type DsrReport } from './dsrService';
import { memoryVault, resetMemoryVault } from './vault/memoryVault';
import {
  createFolder,
  documentById,
  ensureFolderPath,
  listDocuments,
  listFolders,
  renameFolder,
  trashDocument,
} from './vault/vaultService';
import { setActiveProject } from './projectScope';
import type { VaultContext } from './vault/storageTypes';

const ctx: VaultContext = { userId: 'usr-test', projectId: 'PRJ-001' };
const D1 = '2026-01-10';
const D2 = '2026-01-11';

function report(overrides: Partial<DsrReport> = {}): DsrReport {
  return {
    ...blankReport('PRJ-001', D1),
    reportNo: 'DSR-2082/83-001',
    ...overrides,
  };
}

function file(name: string, contents: string, type = 'application/pdf'): File {
  return new File([contents], name, { type });
}

function fakeAttachment(id: string, name = 'site-photo.jpg'): DsrAttachment {
  return { id, name, ext: 'jpg', sizeBytes: 12, addedAt: '2026-01-10T08:00:00.000Z' };
}

beforeEach(() => {
  localStorage.clear();
  resetMemoryVault();
  setActiveProject('PRJ-001');
});

describe('DSR folder tree', () => {
  it('creates root, month and day folders once, with stable ids', async () => {
    const first = await dsrFolderChain(D1, 'PRJ-001');
    const again = await dsrFolderChain(D1, 'PRJ-001');
    expect(again).toEqual(first);
    expect(first.label).toBe('Daily Site Reports / 2026-01 / 2026-01-10');
    expect(dsrFolderLabel(D1)).toBe(first.label);

    const folders = listFolders('PRJ-001');
    expect(folders).toHaveLength(3);
    expect(folders.map((row) => row.system).sort()).toEqual(['dsr', 'dsr-date', 'dsr-month']);
    const day = folders.find((row) => row.id === first.dateId)!;
    expect(day.parentId).toBe(first.monthId);
  });

  it('keeps resolving after the root is renamed (identity is the flag)', async () => {
    const first = await dsrFolderChain(D1, 'PRJ-001');
    renameFolder(first.rootId, 'Site records', 'PRJ-001');
    const renamed = listFolders('PRJ-001').find((row) => row.id === first.rootId)!;
    // A rename must not lose the managed flag — that is the whole identity.
    expect(renamed.system).toBe('dsr');
    expect(renamed.systemKey).toBeUndefined();

    const second = await dsrFolderChain(D2, 'PRJ-001');
    expect(second.rootId).toBe(first.rootId);
    expect(listFolders('PRJ-001').filter((row) => row.system === 'dsr')).toHaveLength(1);
    expect(existingDsrFolderLabel(D1, 'PRJ-001')).toBe('Site records / 2026-01 / 2026-01-10');
  });

  it('refuses a duplicate managed folder but allows the next month', async () => {
    const root = await dsrRootFolder('PRJ-001');
    expect(() => createFolder('DSR copy', null, 'PRJ-001', 'dsr')).toThrow(/managed folder/i);

    const february = createFolder('2026-02', root.id, 'PRJ-001', 'dsr-month', '2026-02');
    expect(february).toMatchObject({ system: 'dsr-month', systemKey: '2026-02' });
    const january = await dsrMonthFolder(D1, 'PRJ-001');
    expect(january.id).not.toBe(february.id);
  });

  it('never stamps the managed flag on folders a person creates by dropping a directory', () => {
    const id = ensureFolderPath(['Drawings'], null, 'PRJ-001');
    const folder = listFolders('PRJ-001').find((row) => row.id === id)!;
    expect(folder.system).toBeUndefined();
    expect(folder.systemKey).toBeUndefined();
  });

  it('exposes the month and day folders, and the root, as their own lookups', async () => {
    const chain = await dsrFolderChain(D1, 'PRJ-001');
    const root = await dsrRootFolder('PRJ-001');
    const month = await dsrMonthFolder(D1, 'PRJ-001');
    const day = await dsrDateFolder(D1, 'PRJ-001');
    expect(root.id).toBe(chain.rootId);
    expect(month.id).toBe(chain.monthId);
    expect(day.id).toBe(chain.dateId);
    expect(month.name).toBe('2026-01');
    expect(day.name).toBe(D1);
    expect(month.parentId).toBe(chain.rootId);
    expect(day.parentId).toBe(chain.monthId);
    // Opening a report is read-only: the label exists before any folder does.
    expect(existingDsrFolderLabel(D1, 'PRJ-001')).toBe('Daily Site Reports / 2026-01 / 2026-01-10');
  });

  it('adopts a folder the person had already made with the same name', async () => {
    const manual = createFolder('Daily Site Reports', null, 'PRJ-001');
    const chain = await dsrFolderChain(D1, 'PRJ-001');
    expect(chain.rootId).toBe(manual.id);
    expect(listFolders('PRJ-001').find((row) => row.id === manual.id)?.system).toBe('dsr');
    expect(listFolders('PRJ-001').filter((row) => !row.parentId)).toHaveLength(1);
  });

  it('refuses to invent a folder for an unusable date', async () => {
    expect(isDsrDate('not-a-date')).toBe(false);
    await expect(dsrFolderChain('2026-13', 'PRJ-001')).rejects.toThrow(/valid report date/);
    expect(listFolders('PRJ-001')).toHaveLength(0);
  });

  it('cannot race two uploads into two trees', async () => {
    const [a, b] = await Promise.all([
      dsrFolderChain(D1, 'PRJ-001'),
      dsrFolderChain(D1, 'PRJ-001'),
    ]);
    expect(a).toEqual(b);
    expect(listFolders('PRJ-001')).toHaveLength(3);
  });
});

describe('attaching files', () => {
  it('files the upload in the report day folder with a searchable tag and note', async () => {
    const result = await uploadDsrAttachments({
      files: [file('slab-pour.pdf', 'abc')],
      report: report(),
      ctx,
      storage: memoryVault,
    });
    expect(result.failed).toEqual([]);
    expect(result.added).toHaveLength(1);

    const chain = await dsrFolderChain(D1, 'PRJ-001');
    const doc = documentById(result.added[0].id, 'PRJ-001')!;
    expect(doc.folderId).toBe(chain.dateId);
    expect(doc.tags).toEqual(['dsr', D1]);
    expect(doc.notes).toContain('DSR-2082/83-001');
    expect(result.added[0]).toMatchObject({ name: 'slab-pour.pdf', ext: 'pdf', sizeBytes: 3 });
    expect(dsrAttachmentNotes(report())).toBe('Daily Site Report DSR-2082/83-001 — 2026-01-10');
  });

  it('refuses the whole batch at the cap instead of adding some and dropping the rest', async () => {
    const full = report({
      attachments: Array.from({ length: MAX_DSR_ATTACHMENTS }, (_, i) => fakeAttachment(`doc-${i}`)),
    });
    expect(() => assertAttachable(full, ctx, 1)).toThrow(/50/);
    await expect(
      uploadDsrAttachments({ files: [file('extra.pdf', 'x')], report: full, ctx, storage: memoryVault })
    ).rejects.toThrow(/50/);
    expect(listDocuments('PRJ-001')).toHaveLength(0);
    expect(listFolders('PRJ-001')).toHaveLength(0);
  });

  it('creates nothing when the upload is cancelled before it starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await uploadDsrAttachments({
      files: [file('photo.jpg', 'x', 'image/jpeg')],
      report: report(),
      ctx,
      storage: memoryVault,
      signal: controller.signal,
    });
    expect(result.added).toHaveLength(0);
    expect(result.failed[0]).toMatchObject({ name: 'photo.jpg', message: 'Cancelled.' });
    expect(listDocuments('PRJ-001')).toHaveLength(0);
    expect(listFolders('PRJ-001')).toHaveLength(0);
  });

  it('keeps a good file when another one in the batch fails', async () => {
    const empty = file('empty.pdf', '');
    const good = file('challan.pdf', 'ok');
    const result = await uploadDsrAttachments({
      files: [empty, good],
      report: report(),
      ctx,
      storage: memoryVault,
    });
    expect(result.added).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].name).toBe('empty.pdf');
  });

  it('refuses a report that belongs to another job', async () => {
    const foreign = report({ project_id: 'PRJ-999' });
    await expect(
      uploadDsrAttachments({ files: [file('a.pdf', 'x')], report: foreign, ctx, storage: memoryVault })
    ).rejects.toThrow(/another job/);
    expect(listFolders('PRJ-001')).toHaveLength(0);
  });

  it('refuses a signed-out account and creates no folder', () => {
    expect(() => assertAttachable(report(), { userId: '', projectId: 'PRJ-001' })).toThrow(
      /Sign in/
    );
    expect(listFolders('PRJ-001')).toHaveLength(0);
  });

  it('reports progress from 0 to 100 for the file', async () => {
    const seen: number[] = [];
    await uploadDsrAttachments({
      files: [file('slab.pdf', 'abc')],
      report: report(),
      ctx,
      storage: memoryVault,
      onProgress: (percent) => seen.push(percent),
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(100);
    expect(seen.every((value) => value >= 0 && value <= 100)).toBe(true);
  });

  it('cancels through the exported controller helper', () => {
    const controller = new AbortController();
    expect(controller.signal.aborted).toBe(false);
    cancelDsrUpload(controller);
    expect(controller.signal.aborted).toBe(true);
    // A missing controller is a no-op, not a crash.
    expect(() => cancelDsrUpload(null)).not.toThrow();
  });
});

describe('retargeting after a date change', () => {
  it('moves the linked file into the new day folder and updates its note', async () => {
    const first = await uploadDsrAttachments({
      files: [file('cube-test.pdf', 'abc')],
      report: report(),
      ctx,
      storage: memoryVault,
    });
    const moved = await retargetDsrAttachments(
      report({ date: D2, attachments: first.added }),
      ctx
    );
    expect(moved.moved).toBe(1);
    const chain = await dsrFolderChain(D2, 'PRJ-001');
    const doc = documentById(first.added[0].id, 'PRJ-001')!;
    expect(doc.folderId).toBe(chain.dateId);
    expect(doc.tags).toEqual(['dsr', D2]);
    expect(doc.notes).toContain(D2);
  });

  it('leaves the file in its old folder and warns when the move itself fails', async () => {
    const uploaded = await uploadDsrAttachments({
      files: [file('challan.pdf', 'abc')],
      report: report(),
      ctx,
      storage: memoryVault,
    });
    const docId = uploaded.added[0].id;
    const original = documentById(docId, 'PRJ-001')!;
    const documentsKey = 'contractoros_vault_documents::PRJ-001';

    const realSetItem = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string
    ) {
      if (key === documentsKey) throw new Error('The vault index is full.');
      realSetItem.call(this, key, value);
    });

    try {
      const result = await retargetDsrAttachments(
        report({ date: D2, attachments: uploaded.added }),
        ctx
      );
      expect(result.moved).toBe(0);
      expect(result.warnings.join(' ')).toMatch(/stayed in its old folder/);
    } finally {
      spy.mockRestore();
    }

    // The bytes and the folder are untouched; only the report's link survives.
    expect(documentById(docId, 'PRJ-001')?.folderId).toBe(original.folderId);
  });

  it('warns about a file that is no longer in the vault instead of failing the save', async () => {
    const moved = await retargetDsrAttachments(
      report({ date: D2, attachments: [fakeAttachment('doc-gone', 'gone.jpg')] }),
      ctx
    );
    expect(moved.moved).toBe(0);
    expect(moved.warnings.join(' ')).toMatch(/no longer in the Vault/);
  });
});

describe('linking rules', () => {
  it('detaching removes only the link — the bytes stay in the vault', async () => {
    const uploaded = await uploadDsrAttachments({
      files: [file('photo.jpg', 'abc', 'image/jpeg')],
      report: report(),
      ctx,
      storage: memoryVault,
    });
    const withLink = report({ attachments: uploaded.added });
    const detached = withoutDsrAttachment(withLink, uploaded.added[0].id);
    expect(detached.attachments).toHaveLength(0);
    expect(documentById(uploaded.added[0].id, 'PRJ-001')).not.toBeNull();
    expect(await memoryVault.exists(ctx, {
      docId: uploaded.added[0].id,
      ext: 'jpg',
      variant: 'file',
    })).toBe(true);
  });

  it('merges without duplicating an id and keeps the cap', () => {
    const rows = [fakeAttachment('a'), fakeAttachment('b')];
    expect(mergeDsrAttachments(rows, [fakeAttachment('b'), fakeAttachment('c')])).toHaveLength(3);
    const many = Array.from({ length: MAX_DSR_ATTACHMENTS }, (_, i) => fakeAttachment(`x-${i}`));
    expect(mergeDsrAttachments(many, [fakeAttachment('one-more')])).toHaveLength(MAX_DSR_ATTACHMENTS);
  });

  it('a trashed file is still linked, with an honest state', async () => {
    const uploaded = await uploadDsrAttachments({
      files: [file('a.pdf', 'x')],
      report: report(),
      ctx,
      storage: memoryVault,
    });
    trashDocument(uploaded.added[0].id, 'PRJ-001');
    expect(documentById(uploaded.added[0].id, 'PRJ-001')?.deletedAt).toBeTruthy();
  });
});

describe('vault focus', () => {
  it('round-trips one instruction and then clears it', () => {
    focusInVault({ projectId: 'PRJ-001', docId: 'doc-1' });
    expect(takeVaultFocus('PRJ-001')).toMatchObject({ projectId: 'PRJ-001', docId: 'doc-1' });
    expect(takeVaultFocus('PRJ-001')).toBeNull();
  });

  it('ignores a focus written for another job', () => {
    focusInVault({ projectId: 'PRJ-002', docId: 'doc-1' });
    expect(takeVaultFocus('PRJ-001')).toBeNull();
    expect(takeVaultFocus('PRJ-001')).toBeNull();
  });

  it('ignores a focus left behind long ago', () => {
    localStorage.setItem(
      'contractoros_vault_focus',
      JSON.stringify({ projectId: 'PRJ-001', docId: 'doc-1', folderId: null, at: Date.now() - 120_000 })
    );
    expect(takeVaultFocus('PRJ-001')).toBeNull();
    expect(localStorage.getItem('contractoros_vault_focus')).toBeNull();
  });
});
