// ============================================================================
// File Vault — the storage boundary.
//
// The page and the service talk to this interface only. Three implementations
// satisfy it:
//
//   desktop  real files under the app's data folder (the real product)
//   browser  IndexedDB blobs (development in a browser; device-local)
//   memory   an in-memory stand-in so tests and unsupported contexts work
//
// Every call carries the account + job context, so a vault can never resolve a
// path or a key from a different account or a different project.
// ============================================================================
import type { VaultMode } from '../../types/vault';

export interface VaultContext {
  userId: string;
  projectId: string;
}

export type VaultVariant = 'file' | 'thumb';

export interface VaultWriteInfo {
  checksum: string;
  sizeBytes: number;
}

export interface VaultUsage {
  files: number;
  bytes: number;
}

export interface VaultCopyInfo {
  files: number;
  bytes: number;
}

export interface VaultRestoreInfo {
  restored: number;
  skipped: number;
}

export interface VaultStorage {
  readonly mode: VaultMode;
  begin(
    ctx: VaultContext,
    input: {
      docId: string;
      ext: string;
      variant: VaultVariant;
      totalChunks: number;
      totalBytes: number;
    }
  ): Promise<void>;
  chunk(
    ctx: VaultContext,
    input: { docId: string; variant: VaultVariant; chunkIndex: number; dataBase64: string }
  ): Promise<void>;
  finish(
    ctx: VaultContext,
    input: { docId: string; variant: VaultVariant; checksum?: string }
  ): Promise<VaultWriteInfo>;
  abort(ctx: VaultContext, input: { docId: string; variant: VaultVariant }): Promise<void>;
  /** Base64 of the stored bytes, or null when the file is not on this device. */
  readBase64(
    ctx: VaultContext,
    input: { docId: string; ext: string; variant: VaultVariant }
  ): Promise<string | null>;
  exists(
    ctx: VaultContext,
    input: { docId: string; ext: string; variant: VaultVariant }
  ): Promise<boolean>;
  remove(ctx: VaultContext, input: { docId: string; ext: string; variant: VaultVariant }): Promise<void>;
  openNative?(ctx: VaultContext, input: { docId: string; ext: string }): Promise<void>;
  revealNative?(ctx: VaultContext, input: { docId: string; ext: string }): Promise<void>;
  exportCopy?(
    ctx: VaultContext,
    input: { docId: string; ext: string; fileName: string }
  ): Promise<string>;
  folderPath?(ctx: VaultContext): Promise<string>;
  revealFolder?(ctx: VaultContext): Promise<void>;
  usage?(ctx: VaultContext): Promise<VaultUsage>;
  backupCopy?(
    ctx: VaultContext,
    input: { destination: string }
  ): Promise<VaultCopyInfo>;
  restoreCopy?(
    ctx: VaultContext,
    input: { source: string }
  ): Promise<VaultRestoreInfo>;
  purgeUser?(userId: string): Promise<number>;
}
