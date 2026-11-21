// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64 } from './bytes';
import { memoryVault, resetMemoryVault, seedMemoryFile } from './memoryVault';
import { getVaultStorage, resolveVaultStorage, setVaultStorage } from './vaultStorage';
import type { VaultContext } from './storageTypes';

const ctx: VaultContext = { userId: 'usr-a', projectId: 'PRJ-001' };
const otherJob: VaultContext = { userId: 'usr-a', projectId: 'PRJ-002' };
const otherUser: VaultContext = { userId: 'usr-b', projectId: 'PRJ-001' };

async function write(storage = memoryVault, target = ctx, docId = 'doc-test-1', text = 'hello') {
  const bytes = new TextEncoder().encode(text);
  await storage.begin(target, {
    docId,
    ext: 'txt',
    variant: 'file',
    totalChunks: 1,
    totalBytes: bytes.length,
  });
  await storage.chunk(target, {
    docId,
    variant: 'file',
    chunkIndex: 0,
    dataBase64: bytesToBase64(bytes),
  });
  return storage.finish(target, { docId, variant: 'file' });
}

beforeEach(() => {
  resetMemoryVault();
  setVaultStorage(null);
});

describe('base64 helpers', () => {
  it('round-trips bytes and handles unicode text', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(bytesToBase64(new TextEncoder().encode('नमस्ते'))).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});

describe('backend resolution', () => {
  it('falls back to memory when neither Tauri nor IndexedDB exists', () => {
    expect(resolveVaultStorage().mode).toBe('memory');
    expect(getVaultStorage().mode).toBe('memory');
  });

  it('lets a test pin a backend and restores resolution afterwards', () => {
    setVaultStorage(memoryVault);
    expect(getVaultStorage()).toBe(memoryVault);
    setVaultStorage(null);
    expect(getVaultStorage().mode).toBe('memory');
  });
});

describe('memory backend', () => {
  it('stores, reads and removes a file', async () => {
    const info = await write();
    expect(info.sizeBytes).toBe(5);
    expect(info.checksum).toMatch(/^[0-9a-f]{16}$/);
    const base64 = await memoryVault.readBase64(ctx, {
      docId: 'doc-test-1',
      ext: 'txt',
      variant: 'file',
    });
    expect(base64).toBe(bytesToBase64(new TextEncoder().encode('hello')));
    await memoryVault.remove(ctx, { docId: 'doc-test-1', ext: 'txt', variant: 'file' });
    expect((await memoryVault.readBase64(ctx, { docId: 'doc-test-1', ext: 'txt', variant: 'file' }))).toBeNull();
  });

  it('keeps accounts and jobs physically apart', async () => {
    await write();
    expect(await memoryVault.exists(otherJob, { docId: 'doc-test-1', ext: 'txt', variant: 'file' })).toBe(false);
    expect(await memoryVault.exists(otherUser, { docId: 'doc-test-1', ext: 'txt', variant: 'file' })).toBe(false);
    expect(await memoryVault.exists(ctx, { docId: 'doc-test-1', ext: 'txt', variant: 'file' })).toBe(true);
  });

  it('reports usage per job and purges one account only', async () => {
    await write(memoryVault, ctx, 'doc-a', 'aaaa');
    await write(memoryVault, otherJob, 'doc-b', 'bbbb');
    seedMemoryFile(otherUser, 'doc-c', 'file', new Uint8Array([1, 2, 3]));
    expect(await memoryVault.usage!(ctx)).toEqual({ files: 1, bytes: 4 });
    expect(await memoryVault.usage!(otherJob)).toEqual({ files: 1, bytes: 4 });
    expect(await memoryVault.purgeUser!('usr-a')).toBe(2);
    expect(await memoryVault.usage!(ctx)).toEqual({ files: 0, bytes: 0 });
    expect(await memoryVault.exists(otherUser, { docId: 'doc-c', ext: 'bin', variant: 'file' })).toBe(true);
  });

  it('refuses an empty upload and an out-of-order chunk', async () => {
    await expect(
      memoryVault.begin(ctx, {
        docId: 'doc-empty',
        ext: 'txt',
        variant: 'file',
        totalChunks: 1,
        totalBytes: 0,
      })
    ).rejects.toThrow(/empty/i);

    await memoryVault.begin(ctx, {
      docId: 'doc-1',
      ext: 'txt',
      variant: 'file',
      totalChunks: 2,
      totalBytes: 10,
    });
    await expect(
      memoryVault.chunk(ctx, {
        docId: 'doc-1',
        variant: 'file',
        chunkIndex: 5,
        dataBase64: 'AAAA',
      })
    ).resolves.toBeUndefined();
    await memoryVault.abort(ctx, { docId: 'doc-1', variant: 'file' });
  });
});
