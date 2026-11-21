// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_VAULT_FILE_BYTES,
  VAULT_CHUNK_BYTES,
  activeDocuments,
  createFolder,
  deleteFolder,
  emptyTrash,
  extensionOf,
  folderLabel,
  kindOf,
  listDocuments,
  listFolders,
  moveFolder,
  normalizeTags,
  queryDocuments,
  readPreview,
  renameFolder,
  restoreDocument,
  trashDocument,
  updateDocument,
  uploadDocument,
  vaultSummary,
  type VaultUploadInput,
} from './vaultService';
import { memoryVault, resetMemoryVault } from './memoryVault';
import { setActiveProject } from '../projectScope';
import type { VaultContext } from './storageTypes';

const ctx: VaultContext = { userId: 'usr-test', projectId: 'PRJ-001' };

function fileOf(name: string, contents: string, type = 'application/pdf'): File {
  return new File([contents], name, { type });
}

async function add(overrides: Partial<VaultUploadInput> = {}) {
  const result = await uploadDocument({
    file: fileOf('site-plan.pdf', 'drawing bytes'),
    ctx,
    storage: memoryVault,
    ...overrides,
  });
  return result.document;
}

beforeEach(() => {
  localStorage.clear();
  resetMemoryVault();
  setActiveProject('PRJ-001');
});

describe('classification', () => {
  it('maps the real-world extensions a contractor hands over', () => {
    expect(kindOf('carbon-copy.pdf')).toBe('pdf');
    expect(kindOf('foundation.dwg')).toBe('drawing');
    expect(kindOf('rates.xlsx')).toBe('excel');
    expect(kindOf('contract.docx')).toBe('word');
    expect(kindOf('site.jpg')).toBe('image');
    expect(kindOf('variation-03.zip')).toBe('archive');
    expect(kindOf('notes.txt')).toBe('text');
    expect(kindOf('mystery.xyz')).toBe('other');
    expect(extensionOf('no extension')).toBe('');
    expect(extensionOf('.hidden')).toBe('');
  });
});

describe('folders', () => {
  it('creates, renames and refuses duplicate names in one parent', () => {
    const drawings = createFolder('Drawings', null, ctx.projectId);
    expect(listFolders(ctx.projectId).map((f) => f.name)).toEqual(['Drawings']);
    expect(() => createFolder('drawings', null, ctx.projectId)).toThrow(/already exists/i);
    const renamed = renameFolder(drawings.id, 'Approved drawings', ctx.projectId);
    expect(renamed.name).toBe('Approved drawings');
    expect(folderLabel(listFolders(ctx.projectId), drawings.id)).toBe('Approved drawings');
  });

  it('will not move a folder inside its own child', () => {
    const parent = createFolder('Parent', null, ctx.projectId);
    const child = createFolder('Child', parent.id, ctx.projectId);
    expect(() => moveFolder(parent.id, child.id, ctx.projectId)).toThrow(/inside itself/i);
  });

  it('deleting a folder moves its files and subfolders up instead of deleting them', async () => {
    const parent = createFolder('Drawings', null, ctx.projectId);
    const child = createFolder('Revision A', parent.id, ctx.projectId);
    const doc = await add({ folderId: child.id });
    const removed = deleteFolder(child.id, ctx.projectId);
    expect(removed).toEqual({ documents: 1, folders: 0 });
    expect(listFolders(ctx.projectId).map((f) => f.id)).toEqual([parent.id]);
    expect(listDocuments(ctx.projectId).find((row) => row.id === doc.id)?.folderId).toBe(parent.id);
  });
});

describe('uploads', () => {
  it('stores the bytes once and records honest metadata', async () => {
    const doc = await add();
    expect(doc.name).toBe('site-plan.pdf');
    expect(doc.ext).toBe('pdf');
    expect(doc.kind).toBe('pdf');
    expect(doc.sizeBytes).toBe('drawing bytes'.length);
    expect(doc.checksum).toMatch(/^[0-9a-f]{16}$/);
    expect(await memoryVault.exists(ctx, { docId: doc.id, ext: doc.ext, variant: 'file' })).toBe(true);
    expect(activeDocuments(ctx.projectId)).toHaveLength(1);
  });

  it('rejects an empty file, an oversized file and a missing job', async () => {
    await expect(
      uploadDocument({ file: fileOf('empty.pdf', ''), ctx, storage: memoryVault })
    ).rejects.toThrow(/empty/i);

    const big = fileOf('huge.dwg', 'x');
    Object.defineProperty(big, 'size', { value: MAX_VAULT_FILE_BYTES + 1 });
    await expect(
      uploadDocument({ file: big, ctx, storage: memoryVault })
    ).rejects.toThrow(/limited/i);

    await expect(
      uploadDocument({
        file: fileOf('a.pdf', 'x'),
        ctx: { userId: 'usr-test', projectId: '' },
        storage: memoryVault,
      })
    ).rejects.toThrow(/Sign in/i);
  });

  it('splits a larger file into chunks and reports progress', async () => {
    const bytes = 'a'.repeat(VAULT_CHUNK_BYTES + 16);
    const seen: number[] = [];
    const result = await uploadDocument({
      file: fileOf('big.pdf', bytes),
      ctx,
      storage: memoryVault,
      onProgress: (percent) => seen.push(percent),
    });
    expect(result.document.sizeBytes).toBe(bytes.length);
    expect(seen[0]).toBeLessThan(100);
    expect(seen[seen.length - 1]).toBe(100);
  });

  it('flags a duplicate in the same folder without blocking it', async () => {
    await add();
    const second = await uploadDocument({
      file: fileOf('site-plan.pdf', 'drawing bytes'),
      ctx,
      storage: memoryVault,
    });
    expect(second.duplicate).toBe(true);
    expect(activeDocuments(ctx.projectId)).toHaveLength(2);
  });

  it('rejects unsafe display names rather than writing a path', async () => {
    const doc = await add({ file: fileOf('../../etc/passwd', 'x') });
    expect(doc.name).toBe('..-..-etc-passwd');
    expect(doc.name).not.toContain('/');
  });
});

describe('search and summaries', () => {
  it('filters by text, kind, folder and tag, and sorts', async () => {
    const drawings = createFolder('Drawings', null, ctx.projectId);
    await add({ folderId: drawings.id, tags: ['approved', 'revision'] });
    await add({ file: fileOf('quote.docx', 'x', 'application/msword'), tags: ['draft'] });

    expect(queryDocuments(listDocuments(ctx.projectId), { query: 'site' }).total).toBe(1);
    expect(queryDocuments(listDocuments(ctx.projectId), { kind: 'word' }).total).toBe(1);
    expect(queryDocuments(listDocuments(ctx.projectId), { folderId: drawings.id }).total).toBe(1);
    expect(queryDocuments(listDocuments(ctx.projectId), { folderId: null }).total).toBe(1);
    expect(queryDocuments(listDocuments(ctx.projectId), { tag: 'approved' }).total).toBe(1);
    expect(
      queryDocuments(listDocuments(ctx.projectId), { query: 'drawings' }, listFolders(ctx.projectId))
        .total
    ).toBe(1);
    expect(queryDocuments(listDocuments(ctx.projectId), { sort: 'name' }).rows[0].name).toBe('quote.docx');
    expect(queryDocuments(listDocuments(ctx.projectId), { query: 'nothing-here' }).total).toBe(0);
  });

  it('normalises tags and bounds them', () => {
    expect(normalizeTags([' Approved ', 'approved', 'REVISION A'])).toEqual(['approved', 'revision a']);
    expect(normalizeTags(Array.from({ length: 20 }, (_, i) => `tag-${i}`))).toHaveLength(12);
  });

  it('publishes totals that exclude the trash', async () => {
    const doc = await add();
    await add({ file: fileOf('second.pdf', 'second') });
    expect(vaultSummary(listDocuments(ctx.projectId))).toMatchObject({ files: 2 });
    trashDocument(doc.id, ctx.projectId);
    expect(vaultSummary(listDocuments(ctx.projectId)).files).toBe(1);
  });
});

describe('trash', () => {
  it('restores to the folder it came from, or to Unsorted when that folder is gone', async () => {
    const folder = createFolder('Tender', null, ctx.projectId);
    const doc = await add({ folderId: folder.id });
    trashDocument(doc.id, ctx.projectId);
    expect(activeDocuments(ctx.projectId)).toHaveLength(0);

    restoreDocument(doc.id, ctx.projectId);
    expect(listDocuments(ctx.projectId).find((row) => row.id === doc.id)?.folderId).toBe(folder.id);

    trashDocument(doc.id, ctx.projectId);
    deleteFolder(folder.id, ctx.projectId);
    const restored = restoreDocument(doc.id, ctx.projectId);
    expect(restored.folderId).toBeNull();
  });

  it('empties the trash and removes the files, not just the rows', async () => {
    const doc = await add();
    trashDocument(doc.id, ctx.projectId);
    const removed = await emptyTrash(ctx, memoryVault);
    expect(removed).toBe(1);
    expect(listDocuments(ctx.projectId)).toHaveLength(0);
    expect(await memoryVault.exists(ctx, { docId: doc.id, ext: doc.ext, variant: 'file' })).toBe(false);
  });
});

describe('editing and integrity', () => {
  it('renames while keeping the extension meaningful', async () => {
    const doc = await add();
    const updated = updateDocument(doc.id, { name: 'issued-plan.pdf', tags: ['issued'] }, ctx.projectId);
    expect(updated.name).toBe('issued-plan.pdf');
    expect(updated.tags).toEqual(['issued']);
    expect(() => updateDocument(doc.id, { name: '   ' }, ctx.projectId)).toThrow(/name/i);
  });

  it('reports a missing file instead of pretending it is there', async () => {
    const doc = await add();
    await memoryVault.remove(ctx, { docId: doc.id, ext: doc.ext, variant: 'file' });
    const preview = await readPreview(ctx, doc, memoryVault);
    expect(preview.status).toBe('missing');
  });

  it('reads text back for the preview pane', async () => {
    const doc = await add({
      file: fileOf('notes.txt', 'line one\nline two', 'text/plain'),
    });
    const preview = await readPreview(ctx, doc, memoryVault);
    expect(preview.status).toBe('ready');
    expect(preview.kind).toBe('text');
    expect(preview.text).toContain('line two');
  });
});

describe('job isolation', () => {
  it('never shows one job’s documents in another job', async () => {
    await add();
    setActiveProject('PRJ-002');
    expect(listDocuments('PRJ-002')).toHaveLength(0);
    setActiveProject('PRJ-001');
    expect(listDocuments('PRJ-001')).toHaveLength(1);
  });

  it('keeps the same document id unreadable from another job', async () => {
    const doc = await add();
    const other = { userId: ctx.userId, projectId: 'PRJ-002' };
    expect(await memoryVault.exists(other, { docId: doc.id, ext: doc.ext, variant: 'file' })).toBe(false);
  });
});
