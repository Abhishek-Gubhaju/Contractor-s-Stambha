// Browser fallback for the File Vault.
//
// localStorage cannot hold documents, so a browser build keeps the bytes in
// IndexedDB. They are namespaced by account and job exactly like the desktop
// folder, and the UI warns that this copy is device-local and NOT part of a ZIP
// backup. The desktop app is the supported home for real documents.
import { base64ToBytes, bytesToBase64 } from './bytes';
import type {
  VaultContext,
  VaultStorage,
  VaultUsage,
  VaultVariant,
  VaultWriteInfo,
} from './storageTypes';

const DB_NAME = 'contractoros-vault';
const DB_VERSION = 1;
const STORE = 'files';

interface StoredBlob {
  key: string;
  blob: Blob;
  updatedAt: string;
}

const pending = new Map<string, Uint8Array[]>();

function keyOf(ctx: VaultContext, docId: string, variant: VaultVariant): string {
  return `${ctx.userId}/${ctx.projectId}/${docId}/${variant}`;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Browser storage refused the request.'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Browser storage refused the request.'));
    tx.onabort = () => reject(tx.error || new Error('Browser storage cancelled the request.'));
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Browser storage is unavailable.'));
  });
  return dbPromise;
}

async function getRecord(key: string): Promise<StoredBlob | null> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const record = await request<StoredBlob | undefined>(tx.objectStore(STORE).get(key));
  return record ?? null;
}

async function putRecord(record: StoredBlob): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(record);
  await done(tx);
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

function fnv1a64(bytes: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, '0');
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const browserVault: VaultStorage = {
  mode: 'browser',

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
    const mapKey = keyOf(ctx, input.docId, input.variant);
    const parts = pending.get(mapKey);
    if (!parts) throw new Error('That upload is no longer active — start it again.');
    pending.delete(mapKey);
    const bytes = join(parts);
    if (bytes.length === 0) throw new Error('The upload did not finish — the file is incomplete.');
    const checksum = fnv1a64(bytes);
    if (input.checksum && input.checksum !== checksum) {
      throw new Error('The file changed while it was being saved. Try again.');
    }
    try {
      await putRecord({
        key: mapKey,
        blob: new Blob([bytes.buffer as ArrayBuffer], { type: 'application/octet-stream' }),
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      throw new Error(
        `There is not enough browser storage for this file. ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    return { checksum, sizeBytes: bytes.length };
  },

  async abort(ctx, input) {
    pending.delete(keyOf(ctx, input.docId, input.variant));
  },

  async readBase64(ctx, input) {
    const record = await getRecord(keyOf(ctx, input.docId, input.variant));
    if (!record) return null;
    const buffer = await record.blob.arrayBuffer();
    return bytesToBase64(new Uint8Array(buffer));
  },

  async exists(ctx, input) {
    return Boolean(await getRecord(keyOf(ctx, input.docId, input.variant)));
  },

  async remove(ctx, input) {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(keyOf(ctx, input.docId, 'file'));
    tx.objectStore(STORE).delete(keyOf(ctx, input.docId, 'thumb'));
    await done(tx);
  },

  async openNative(ctx, input) {
    const record = await getRecord(keyOf(ctx, input.docId, 'file'));
    if (!record) throw new Error('That file is missing from this browser.');
    const url = URL.createObjectURL(record.blob);
    const opened = window.open(url, '_blank', 'noopener');
    if (!opened) {
      URL.revokeObjectURL(url);
      throw new Error('The browser blocked the preview tab. Use Save a copy instead.');
    }
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },

  async exportCopy(ctx, input) {
    const record = await getRecord(keyOf(ctx, input.docId, 'file'));
    if (!record) throw new Error('That file is missing from this browser.');
    download(record.blob, input.fileName);
    return input.fileName;
  },

  async folderPath() {
    return 'This browser’s storage (device-local)';
  },

  async usage(ctx): Promise<VaultUsage> {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const records = await request<StoredBlob[]>(tx.objectStore(STORE).getAll());
    const prefix = `${ctx.userId}/${ctx.projectId}/`;
    let files = 0;
    let bytes = 0;
    for (const record of records) {
      if (!record.key.startsWith(prefix) || !record.key.endsWith('/file')) continue;
      files += 1;
      bytes += record.blob.size;
    }
    return { files, bytes };
  },

  async purgeUser(userId) {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const keys = await request<IDBValidKey[]>(tx.objectStore(STORE).getAllKeys());
    let removed = 0;
    for (const key of keys) {
      if (typeof key !== 'string' || !key.startsWith(`${userId}/`)) continue;
      tx.objectStore(STORE).delete(key);
      removed += 1;
    }
    await done(tx);
    return removed;
  },
};
