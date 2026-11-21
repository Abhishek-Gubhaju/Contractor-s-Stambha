// Desktop bridge for the File Vault.
//
// Mirrors `services/backup/desktop.ts`: the webview calls our own Tauri
// commands, and every path decision stays in Rust. Nothing here stores or
// interprets document bytes beyond passing chunks through.
import { isDesktopApp } from '../backup/desktop';
import type {
  VaultContext,
  VaultCopyInfo,
  VaultRestoreInfo,
  VaultStorage,
  VaultUsage,
  VaultVariant,
  VaultWriteInfo,
} from './storageTypes';

interface TauriWindow {
  __TAURI_INTERNALS__?: { invoke?: unknown };
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktopApp() && !(typeof window !== 'undefined' && Boolean((window as unknown as TauriWindow).__TAURI_INTERNALS__))) {
    throw new Error('The File Vault is only available in the desktop app.');
  }
  const mod = await import('@tauri-apps/api/core');
  return mod.invoke<T>(command, args);
}

function context(ctx: VaultContext) {
  return { user: ctx.userId, project: ctx.projectId };
}

export async function vaultUploadBegin(input: {
  ctx: VaultContext;
  docId: string;
  ext: string;
  variant: VaultVariant;
  totalChunks: number;
  totalBytes: number;
}): Promise<void> {
  await invoke<void>('vault_upload_begin', {
    ...context(input.ctx),
    docId: input.docId,
    ext: input.ext,
    totalChunks: input.totalChunks,
    totalBytes: input.totalBytes,
    variant: input.variant,
  });
}

export async function vaultUploadChunk(input: {
  ctx: VaultContext;
  docId: string;
  variant: VaultVariant;
  chunkIndex: number;
  dataBase64: string;
}): Promise<void> {
  await invoke<void>('vault_upload_chunk', {
    ...context(input.ctx),
    docId: input.docId,
    variant: input.variant,
    chunkIndex: input.chunkIndex,
    dataBase64: input.dataBase64,
  });
}

export async function vaultUploadFinish(input: {
  ctx: VaultContext;
  docId: string;
  variant: VaultVariant;
  checksum?: string;
}): Promise<VaultWriteInfo> {
  const info = await invoke<{ checksum: string; size_bytes: number }>('vault_upload_finish', {
    ...context(input.ctx),
    docId: input.docId,
    variant: input.variant,
    checksum: input.checksum ?? null,
  });
  return { checksum: String(info.checksum || ''), sizeBytes: Number(info.size_bytes) || 0 };
}

export async function vaultUploadAbort(input: {
  ctx: VaultContext;
  docId: string;
  variant: VaultVariant;
}): Promise<void> {
  await invoke<void>('vault_upload_abort', {
    ...context(input.ctx),
    docId: input.docId,
    variant: input.variant,
  });
}

export async function vaultReadBase64(input: {
  ctx: VaultContext;
  docId: string;
  ext: string;
  variant: VaultVariant;
}): Promise<string | null> {
  const raw = await invoke<string | null>('vault_read_base64', {
    ...context(input.ctx),
    docId: input.docId,
    ext: input.ext,
    variant: input.variant,
  });
  return raw ?? null;
}

export async function vaultExists(input: {
  ctx: VaultContext;
  docId: string;
  ext: string;
  variant: VaultVariant;
}): Promise<boolean> {
  return invoke<boolean>('vault_exists', {
    ...context(input.ctx),
    docId: input.docId,
    ext: input.ext,
    variant: input.variant,
  });
}

export async function vaultDelete(input: {
  ctx: VaultContext;
  docId: string;
  ext: string;
}): Promise<void> {
  await invoke<void>('vault_delete', {
    ...context(input.ctx),
    docId: input.docId,
    ext: input.ext,
  });
}

export async function vaultUsage(ctx: VaultContext): Promise<VaultUsage> {
  const tuple = await invoke<[number, number]>('vault_usage', context(ctx));
  return { files: Number(tuple?.[0]) || 0, bytes: Number(tuple?.[1]) || 0 };
}

export async function vaultFolderPath(ctx: VaultContext): Promise<string> {
  return invoke<string>('vault_folder', context(ctx));
}

export async function vaultRevealFolder(ctx: VaultContext): Promise<void> {
  await invoke<void>('vault_reveal_folder', context(ctx));
}

export async function vaultOpen(input: { ctx: VaultContext; docId: string; ext: string }): Promise<void> {
  await invoke<void>('vault_open', { ...context(input.ctx), docId: input.docId, ext: input.ext });
}

export async function vaultReveal(input: { ctx: VaultContext; docId: string; ext: string }): Promise<void> {
  await invoke<void>('vault_reveal', { ...context(input.ctx), docId: input.docId, ext: input.ext });
}

export async function vaultExportCopy(input: {
  ctx: VaultContext;
  docId: string;
  ext: string;
  fileName: string;
}): Promise<string> {
  return invoke<string>('vault_export_copy', {
    ...context(input.ctx),
    docId: input.docId,
    ext: input.ext,
    fileName: input.fileName,
  });
}

export async function vaultBackupCopy(
  ctx: VaultContext,
  destination: string
): Promise<VaultCopyInfo> {
  const info = await invoke<{ files: number; bytes: number }>('vault_backup_copy', {
    ...context(ctx),
    destination,
  });
  return { files: Number(info?.files) || 0, bytes: Number(info?.bytes) || 0 };
}

export async function vaultRestoreCopy(
  ctx: VaultContext,
  source: string
): Promise<VaultRestoreInfo> {
  const info = await invoke<{ restored: number; skipped: number }>('vault_restore_copy', {
    ...context(ctx),
    source,
  });
  return { restored: Number(info?.restored) || 0, skipped: Number(info?.skipped) || 0 };
}

export async function vaultPurgeUser(userId: string): Promise<number> {
  return invoke<number>('vault_purge_user', { user: userId });
}

export const desktopVault: VaultStorage = {
  mode: 'desktop',
  begin: (ctx, input) => vaultUploadBegin({ ctx, ...input }),
  chunk: (ctx, input) => vaultUploadChunk({ ctx, ...input }),
  finish: (ctx, input) => vaultUploadFinish({ ctx, ...input }),
  abort: (ctx, input) => vaultUploadAbort({ ctx, ...input }),
  readBase64: (ctx, input) => vaultReadBase64({ ctx, ...input }),
  exists: (ctx, input) => vaultExists({ ctx, ...input }),
  remove: (ctx, input) => vaultDelete({ ctx, docId: input.docId, ext: input.ext }),
  openNative: (ctx, input) => vaultOpen({ ctx, ...input }),
  revealNative: (ctx, input) => vaultReveal({ ctx, ...input }),
  exportCopy: (ctx, input) => vaultExportCopy({ ctx, ...input }),
  folderPath: (ctx) => vaultFolderPath(ctx),
  revealFolder: (ctx) => vaultRevealFolder(ctx),
  usage: (ctx) => vaultUsage(ctx),
  backupCopy: (ctx, input) => vaultBackupCopy(ctx, input.destination),
  restoreCopy: (ctx, input) => vaultRestoreCopy(ctx, input.source),
  purgeUser: (userId) => vaultPurgeUser(userId),
};
