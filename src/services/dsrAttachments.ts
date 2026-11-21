// ============================================================================
// dsrAttachments — the bridge between a Daily Site Report and the File Vault.
//
// A report never stores bytes. It links vault documents, and those documents
// are filed in a tree the app owns:
//
//   Daily Site Reports / 2026-11 / 2026-11-20
//   (root, system 'dsr')  (month 'dsr-month')  (day 'dsr-date')
//
// The day folder is the report's own date (A.D.), so a job's site photographs
// and delivery challans sit together by day instead of in one undifferentiated
// list. The folders are metadata only — the bytes keep the vault's existing
// `vault/<user>/<PROJECT>/<docId>.<ext>` layout, which is what makes backup,
// restore, trash and the native layer work unchanged.
//
// Rules that matter:
//   • identity is the `system` flag, never the folder name — renaming the tree
//     in the Vault must not send the next upload somewhere else
//   • ensures are serialised per project, so a double click cannot create two
//     "Daily Site Reports" folders
//   • an upload is immediate; a discarded draft leaves its files in the Vault
//     (visible, searchable, deletable there) rather than losing them
//   • detaching only removes the link; no byte is deleted from the editor
// ============================================================================
import type { VaultFolder, VaultFolderSystem } from '../types/vault';
import {
  MAX_DSR_ATTACHMENTS,
  type DsrAttachment,
  type DsrReport,
} from './dsrService';
import type { VaultContext, VaultStorage } from './vault/storageTypes';
import { getVaultStorage } from './vault/vaultStorage';
import {
  createFolder,
  documentById,
  listDocuments,
  listFolders,
  setFolderSystem,
  updateDocument,
  uploadDocument,
} from './vault/vaultService';

export const DSR_ROOT_FOLDER_NAME = 'Daily Site Reports';
/** A one-shot instruction for the Vault page (written before navigating). */
export const VAULT_FOCUS_KEY = 'contractoros_vault_focus';
const FOCUS_MAX_AGE_MS = 60_000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDsrDate(date: string): boolean {
  return DATE_RE.test(String(date || '').slice(0, 10));
}

export function dsrMonthName(date: string): string {
  return String(date).slice(0, 7);
}

export function dsrDateName(date: string): string {
  return String(date).slice(0, 10);
}

/** The label the editor and the printed sheet use for the whole chain. */
export function dsrFolderLabel(date: string): string {
  if (!isDsrDate(date)) return DSR_ROOT_FOLDER_NAME;
  return `${DSR_ROOT_FOLDER_NAME} / ${dsrMonthName(date)} / ${dsrDateName(date)}`;
}

export function dsrAttachmentTags(date: string): string[] {
  return ['dsr', dsrDateName(date)];
}

export function dsrAttachmentNotes(report: DsrReport): string {
  const number = String(report.reportNo || '').trim() || 'draft';
  return `Daily Site Report ${number} — ${report.date}`;
}

// ---------------------------------------------------------------------------
// Serialised folder resolution
// ---------------------------------------------------------------------------
const chains = new Map<string, Promise<unknown>>();

/**
 * Run `task` after every earlier task for the same project. Folder creation is
 * a read-then-write on localStorage; without this, two fast uploads can both
 * see "no folder" and create two of them.
 */
function serial<T>(key: string, task: () => Promise<T> | T): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  chains.set(key, next);
  next
    .finally(() => {
      if (chains.get(key) === next) chains.delete(key);
    })
    .catch(() => undefined);
  return next;
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Find-or-adopt-or-create one managed folder under `parentId`. */
function ensureManagedFolder(
  projectId: string,
  parentId: string | null,
  name: string,
  system: VaultFolderSystem,
  systemKey?: string
): VaultFolder {
  const folders = listFolders(projectId);
  // Scope by KEY, not by type alone: every month is 'dsr-month' and every day
  // is 'dsr-date', and days share a parent inside their month. A type-only
  // lookup would hand January's 10th to the 11th.
  const managed = folders.find(
    (folder) =>
      folder.system === system &&
      (folder.parentId ?? null) === parentId &&
      (folder.systemKey ?? '') === (systemKey ?? '')
  );
  if (managed) return managed;

  const byName = folders.find(
    (folder) => (folder.parentId ?? null) === parentId && sameName(folder.name, name)
  );
  if (byName) {
    // Adopt the folder the person already made, rather than leaving two with
    // the same name and picking one at random later.
    return setFolderSystem(byName.id, system, projectId, systemKey);
  }
  return createFolder(name, parentId, projectId, system, systemKey);
}

export interface DsrFolderChain {
  rootId: string;
  monthId: string;
  dateId: string;
  label: string;
}

interface ChainFolders extends DsrFolderChain {
  root: VaultFolder;
  month: VaultFolder;
  day: VaultFolder;
}

function assertFolderRequest(date: string, projectId: string): void {
  if (!isDsrDate(date)) {
    throw new Error('Set a valid report date before adding files — it decides the folder.');
  }
  if (!projectId) throw new Error('Open a job before adding files.');
}

/** The synchronous core, only ever called inside `serial`. */
function buildChain(date: string, projectId: string): ChainFolders {
  const root = ensureManagedFolder(projectId, null, DSR_ROOT_FOLDER_NAME, 'dsr');
  const month = ensureManagedFolder(
    projectId,
    root.id,
    dsrMonthName(date),
    'dsr-month',
    dsrMonthName(date)
  );
  const day = ensureManagedFolder(
    projectId,
    month.id,
    dsrDateName(date),
    'dsr-date',
    dsrDateName(date)
  );
  return {
    rootId: root.id,
    monthId: month.id,
    dateId: day.id,
    label: `${root.name} / ${month.name} / ${day.name}`,
    root,
    month,
    day,
  };
}

function publicChain(chain: ChainFolders): DsrFolderChain {
  return {
    rootId: chain.rootId,
    monthId: chain.monthId,
    dateId: chain.dateId,
    label: chain.label,
  };
}

/** Resolve (creating if needed) the root → month → day folders for a date. */
export function dsrFolderChain(date: string, projectId: string): Promise<DsrFolderChain> {
  try {
    assertFolderRequest(date, projectId);
  } catch (error) {
    return Promise.reject(error);
  }
  return serial(projectId, () => publicChain(buildChain(date, projectId)));
}

/** The month folder for a date (created on demand). */
export function dsrMonthFolder(date: string, projectId: string): Promise<VaultFolder> {
  try {
    assertFolderRequest(date, projectId);
  } catch (error) {
    return Promise.reject(error);
  }
  return serial(projectId, () => buildChain(date, projectId).month);
}

/** The day folder for a date (created on demand) — the upload target. */
export function dsrDateFolder(date: string, projectId: string): Promise<VaultFolder> {
  try {
    assertFolderRequest(date, projectId);
  } catch (error) {
    return Promise.reject(error);
  }
  return serial(projectId, () => buildChain(date, projectId).day);
}

/** The root alone — used by the vault UI and by a report with no date yet. */
export function dsrRootFolder(projectId: string): Promise<VaultFolder> {
  if (!projectId) return Promise.reject(new Error('Open a job before adding files.'));
  return serial(projectId, () =>
    ensureManagedFolder(projectId, null, DSR_ROOT_FOLDER_NAME, 'dsr', undefined)
  );
}

/**
 * The label for the chain as it exists right now — read-only, so merely opening
 * a report never creates folders. Renamed folders show their real names.
 */
export function existingDsrFolderLabel(date: string, projectId: string): string {
  const canonical = `${DSR_ROOT_FOLDER_NAME} / ${dsrMonthName(date)} / ${dsrDateName(date)}`;
  if (!isDsrDate(date) || !projectId) return canonical;
  const folders = listFolders(projectId);
  const root = folders.find((folder) => folder.system === 'dsr' && !folder.parentId);
  const month = root
    ? folders.find(
        (folder) =>
          folder.system === 'dsr-month' &&
          folder.parentId === root.id &&
          folder.systemKey === dsrMonthName(date)
      )
    : undefined;
  const day = month
    ? folders.find(
        (folder) =>
          folder.system === 'dsr-date' &&
          folder.parentId === month.id &&
          folder.systemKey === dsrDateName(date)
      )
    : undefined;
  return [
    root?.name ?? DSR_ROOT_FOLDER_NAME,
    month?.name ?? dsrMonthName(date),
    day?.name ?? dsrDateName(date),
  ].join(' / ');
}

// ---------------------------------------------------------------------------
// Guards and pure list helpers
// ---------------------------------------------------------------------------
export function assertAttachable(
  report: DsrReport,
  ctx: VaultContext,
  incoming = 0
): void {
  if (!ctx.userId) throw new Error('Sign in before adding files to a report.');
  if (!ctx.projectId) throw new Error('Open a job before adding files.');
  if (report.project_id !== ctx.projectId) {
    throw new Error('This report belongs to another job — open that job to add its files.');
  }
  if (!isDsrDate(report.date)) {
    throw new Error('Set a valid report date before adding files.');
  }
  const existing = report.attachments?.length ?? 0;
  if (existing + incoming > MAX_DSR_ATTACHMENTS) {
    throw new Error(
      `A report can link ${MAX_DSR_ATTACHMENTS} files — this would make ${existing + incoming}. Remove one first.`
    );
  }
}

/** Merge new links into a report's list, ignoring duplicate ids. */
export function mergeDsrAttachments(
  current: DsrAttachment[] = [],
  added: DsrAttachment[] = []
): DsrAttachment[] {
  const seen = new Set<string>();
  const out: DsrAttachment[] = [];
  for (const row of [...current, ...added]) {
    if (!row || !row.id || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
    if (out.length >= MAX_DSR_ATTACHMENTS) break;
  }
  return out;
}

/** Remove one link from a report. The vault document is untouched. */
export function withoutDsrAttachment(report: DsrReport, id: string): DsrReport {
  return {
    ...report,
    attachments: (report.attachments || []).filter((row) => row.id !== id),
  };
}

export type DsrAttachmentState = 'ok' | 'trashed' | 'missing';

/** Where each linked file currently is: live, in Trash, or gone from the index. */
export function dsrAttachmentStates(
  attachments: DsrAttachment[],
  projectId: string
): Map<string, DsrAttachmentState> {
  const docs = new Map(listDocuments(projectId).map((doc) => [doc.id, doc]));
  const states = new Map<string, DsrAttachmentState>();
  for (const row of attachments) {
    const doc = docs.get(row.id);
    states.set(row.id, !doc ? 'missing' : doc.deletedAt ? 'trashed' : 'ok');
  }
  return states;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------
export interface DsrUploadFailure {
  name: string;
  message: string;
}

export interface DsrUploadResult {
  added: DsrAttachment[];
  failed: DsrUploadFailure[];
}

export interface DsrUploadInput {
  files: File[];
  report: DsrReport;
  ctx: VaultContext;
  storage?: VaultStorage;
  /** percent 0–100 for the file currently uploading. */
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

function toAttachment(document: {
  id: string;
  name: string;
  ext: string;
  sizeBytes: number;
  createdAt: string;
}): DsrAttachment {
  return {
    id: document.id,
    name: document.name,
    ext: document.ext,
    sizeBytes: document.sizeBytes,
    addedAt: document.createdAt || new Date().toISOString(),
  };
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Upload files into the report's day folder and return the links to store on
 * the report. One bad file never discards the ones that already succeeded.
 */
export async function uploadDsrAttachments(input: DsrUploadInput): Promise<DsrUploadResult> {
  const { files, report, ctx } = input;
  const storage = input.storage ?? getVaultStorage();
  const list = (files || []).filter(Boolean);

  assertAttachable(report, ctx, list.length);
  if (list.length === 0) return { added: [], failed: [] };

  // A cancelled signal before the first byte should not create folders.
  if (input.signal?.aborted) {
    return {
      added: [],
      failed: list.map((file) => ({ name: file.name, message: 'Cancelled.' })),
    };
  }

  const chain = await dsrFolderChain(report.date, ctx.projectId);
  const added: DsrAttachment[] = [];
  const failed: DsrUploadFailure[] = [];

  for (const file of list) {
    if (input.signal?.aborted) {
      failed.push({ name: file.name, message: 'Cancelled.' });
      continue;
    }
    try {
      const result = await uploadDocument({
        file,
        ctx,
        folderId: chain.dateId,
        tags: dsrAttachmentTags(report.date),
        notes: dsrAttachmentNotes(report),
        storage,
        signal: input.signal,
        onProgress: input.onProgress,
      });
      added.push(toAttachment(result.document));
    } catch (error) {
      if (isAbort(error)) {
        failed.push({ name: file.name, message: 'Cancelled.' });
        continue;
      }
      failed.push({
        name: file.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { added, failed };
}

/** Explicit cancel hook so a screen can abort a controller it owns. */
export function cancelDsrUpload(controller?: AbortController | null): void {
  controller?.abort();
}

// ---------------------------------------------------------------------------
// Retarget (a report's date changed after files were attached)
// ---------------------------------------------------------------------------
export interface DsrRetargetResult {
  moved: number;
  warnings: string[];
}

/**
 * Move a report's linked files into the folder for its current date, and
 * refresh their tag/note so a vault search still finds the report number.
 * Best effort: a file already missing from the vault is a warning, never a
 * reason to refuse saving the report.
 */
export async function retargetDsrAttachments(
  report: DsrReport,
  ctx: VaultContext
): Promise<DsrRetargetResult> {
  const warnings: string[] = [];
  const attachments = report.attachments || [];
  if (attachments.length === 0) return { moved: 0, warnings };
  if (!ctx.userId || !ctx.projectId) {
    return { moved: 0, warnings: ['Sign in to move the linked files into this date’s folder.'] };
  }
  if (report.project_id !== ctx.projectId) {
    return { moved: 0, warnings: ['The report belongs to another job; its files were left where they are.'] };
  }

  let chain: DsrFolderChain;
  try {
    chain = await dsrFolderChain(report.date, ctx.projectId);
  } catch (error) {
    return {
      moved: 0,
      warnings: [error instanceof Error ? error.message : 'The date folder could not be prepared.'],
    };
  }

  let moved = 0;
  for (const attachment of attachments) {
    const doc = documentById(attachment.id, ctx.projectId);
    if (!doc) {
      warnings.push(`“${attachment.name}” is no longer in the Vault — the link was kept.`);
      continue;
    }
    if (doc.folderId === chain.dateId) continue;
    try {
      updateDocument(
        attachment.id,
        {
          folderId: chain.dateId,
          tags: dsrAttachmentTags(report.date),
          notes: dsrAttachmentNotes(report),
        },
        ctx.projectId
      );
      moved += 1;
    } catch (error) {
      warnings.push(
        `“${attachment.name}” stayed in its old folder: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  return { moved, warnings };
}

// ---------------------------------------------------------------------------
// Vault navigation
// ---------------------------------------------------------------------------
export interface VaultFocus {
  projectId: string;
  folderId: string | null;
  docId: string | null;
  at: number;
}

/** Ask the Vault page to open on a folder or a file (used by the DSR editor). */
export function focusInVault(input: {
  projectId: string;
  folderId?: string | null;
  docId?: string | null;
}): void {
  try {
    const focus: VaultFocus = {
      projectId: input.projectId,
      folderId: input.folderId ?? null,
      docId: input.docId ?? null,
      at: Date.now(),
    };
    localStorage.setItem(VAULT_FOCUS_KEY, JSON.stringify(focus));
  } catch {
    /* storage blocked — navigation still happens, just without the target */
  }
}

/**
 * Read and clear the instruction. A focus from another job or from long ago is
 * discarded, so opening the Vault tomorrow never jumps somewhere unexpected.
 */
export function takeVaultFocus(projectId: string): VaultFocus | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(VAULT_FOCUS_KEY);
    localStorage.removeItem(VAULT_FOCUS_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<VaultFocus>;
    if (!value || value.projectId !== projectId) return null;
    if (typeof value.at !== 'number' || Date.now() - value.at > FOCUS_MAX_AGE_MS) return null;
    return {
      projectId,
      folderId: typeof value.folderId === 'string' ? value.folderId : null,
      docId: typeof value.docId === 'string' ? value.docId : null,
      at: value.at,
    };
  } catch {
    return null;
  }
}
