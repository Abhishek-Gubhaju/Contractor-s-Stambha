// In-memory vault storage.
//
// Used by the test suite and by contexts with neither Tauri nor IndexedDB. It
// deliberately behaves like the disk version (chunked writes, checksums,
// thumbnails beside documents, per-account/per-job keys) so tests exercise the
// same code paths as the product.
import { base64ToBytes, bytesToBase64 } from './bytes';
import type {
  VaultContext,
  VaultStorage,
  VaultUsage,
  VaultVariant,
  VaultWriteInfo,
} from './storageTypes';

const store = new Map<string, Uint8Array>();
const pending = new Map<string, Uint8Array[]>();

function keyOf(ctx: VaultContext, docId: string, variant: VaultVariant): string {
  return `${ctx.userId}/${ctx.projectId}/${docId}/${variant}`;
}

function fnv1a64(bytes: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, '0');
}

function join(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function requireBytes(ctx: VaultContext, docId: string, variant: VaultVariant): Uint8Array {
  const bytes = store.get(keyOf(ctx, docId, variant));
  if (!bytes) throw new Error('That file is missing from this device.');
  return bytes;
}

export function resetMemoryVault(): void {
  store.clear();
  pending.clear();
}

export const memoryVault: VaultStorage = {
  mode: 'memory',

  async begin(ctx, input) {
    if (!ctx.userId || !ctx.projectId) throw new Error('The vault needs an account and a job.');
    if (input.totalBytes <= 0) throw new Error('That file is empty — there is nothing to store.');
    if (input.totalChunks <= 0) throw new Error('That file could not be read.');
    pending.set(keyOf(ctx, input.docId, input.variant), []);
  },

  async chunk(ctx, input) {
    const parts = pending.get(keyOf(ctx, input.docId, input.variant));
    if (!parts) throw new Error('That upload is no longer active — start it again.');
    parts.push(base64ToBytes(input.dataBase64));
  },

  async finish(ctx, input): Promise<VaultWriteInfo> {
    const parts = pending.get(keyOf(ctx, input.docId, input.variant));
    if (!parts) throw new Error('That upload is no longer active — start it again.');
    pending.delete(keyOf(ctx, input.docId, input.variant));
    const bytes = join(parts);
    if (bytes.length === 0) throw new Error('The upload did not finish — the file is incomplete.');
    const checksum = fnv1a64(bytes);
    if (input.checksum && input.checksum !== checksum) {
      throw new Error('The file changed while it was being saved. Try again.');
    }
    store.set(keyOf(ctx, input.docId, input.variant), bytes);
    return { checksum, sizeBytes: bytes.length };
  },

  async abort(ctx, input) {
    pending.delete(keyOf(ctx, input.docId, input.variant));
  },

  async readBase64(ctx, input) {
    const bytes = store.get(keyOf(ctx, input.docId, input.variant));
    return bytes ? bytesToBase64(bytes) : null;
  },

  async exists(ctx, input) {
    return store.has(keyOf(ctx, input.docId, input.variant));
  },

  async remove(ctx, input) {
    store.delete(keyOf(ctx, input.docId, 'file'));
    store.delete(keyOf(ctx, input.docId, 'thumb'));
  },

  async exportCopy(_ctx, input) {
    return input.fileName;
  },

  async folderPath() {
    return 'In-memory (this session only)';
  },

  async usage(ctx): Promise<VaultUsage> {
    let files = 0;
    let bytes = 0;
    const prefix = `${ctx.userId}/${ctx.projectId}/`;
    for (const [key, value] of store) {
      if (!key.startsWith(prefix) || !key.endsWith('/file')) continue;
      files += 1;
      bytes += value.length;
    }
    return { files, bytes };
  },

  async purgeUser(userId) {
    let removed = 0;
    for (const key of [...store.keys()]) {
      if (!key.startsWith(`${userId}/`)) continue;
      store.delete(key);
      removed += 1;
    }
    return removed;
  },
};

/** Fixture helper for tests: put bytes in without going through the uploader. */
export function seedMemoryFile(
  ctx: VaultContext,
  docId: string,
  variant: VaultVariant,
  bytes: Uint8Array
): void {
  store.set(keyOf(ctx, docId, variant), bytes);
}
