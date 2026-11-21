// ============================================================================
// vaultService — the File Vault's data rules.
//
// Metadata (documents + folders) is ordinary job data: it is written through
// the project scope, so it is mirrored, backed up and restored like the rest of
// the books. The bytes never come through here into localStorage — uploads are
// streamed to the storage adapter, which owns the disk/browser blob.
//
// The rules that matter:
//   • a folder delete never deletes files: contents move up one level
//   • deleting a file is a soft delete (Trash) until explicitly emptied
//   • a missing file is reported as missing, never silently synthesized
//   • tags are normalised, notes are bounded, names are display names
// ============================================================================
import type {
  VaultDocument,
  VaultFolder,
  VaultFolderSystem,
  VaultKind,
  VaultQuery,
  VaultSort,
  VaultThumb,
} from '../../types/vault';
import { getActiveProject, readScoped, writeScopedStrict } from '../projectScope';
import { formatBytes } from '../staffService';
import { base64Bytes, base64ToText, bytesToBase64, dataUrlBody } from './bytes';
import { makeThumbnail } from './thumbnails';
import type { VaultContext, VaultStorage } from './storageTypes';
import { getVaultStorage } from './vaultStorage';

export const VAULT_DOCUMENTS_KEY = 'contractoros_vault_documents';
export const VAULT_FOLDERS_KEY = 'contractoros_vault_folders';

export const MAX_VAULT_FILE_BYTES = 512 * 1024 * 1024;
export const VAULT_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_INLINE_PREVIEW_BYTES = 64 * 1024 * 1024;
export const VAULT_PAGE_SIZE = 200;
export const MAX_TAGS = 12;
export const MAX_TAG_LENGTH = 30;
export const MAX_NOTES_LENGTH = 2000;

/** The extension list the OS may be asked to open (mirrors the Rust side). */
export const OPEN_EXTENSIONS: ReadonlySet<string> = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'md', 'rtf', 'odt', 'ods',
  'odp', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'dwg', 'dxf',
  'dwf', 'zip', 'rar', '7z', 'mp4', 'mov', 'm4v', 'mp3', 'wav', 'json', 'xml', 'log', 'eml',
]);

const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  'txt', 'csv', 'md', 'json', 'xml', 'log', 'html', 'htm', 'css', 'js', 'ts', 'yml', 'yaml',
  'ini', 'sql', 'eml',
]);

const KIND_BY_EXT: Record<string, VaultKind> = {
  pdf: 'pdf',
  doc: 'word', docx: 'word', odt: 'word', rtf: 'word', pages: 'word',
  xls: 'excel', xlsx: 'excel', ods: 'excel', csv: 'excel', numbers: 'excel',
  ppt: 'powerpoint', pptx: 'powerpoint', odp: 'powerpoint', key: 'powerpoint',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image',
  tif: 'image', tiff: 'image', heic: 'image', svg: 'image', ico: 'image',
  dwg: 'drawing', dxf: 'drawing', dwf: 'drawing', dgn: 'drawing', rvt: 'drawing',
  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive', bz2: 'archive',
  txt: 'text', md: 'text', json: 'text', xml: 'text', log: 'text', html: 'text', css: 'text',
  js: 'text', ts: 'text', yml: 'text', yaml: 'text', ini: 'text', sql: 'text',
};

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
  dwg: 'application/acad',
  dxf: 'image/vnd.dxf',
};

// ---------------------------------------------------------------------------
// Naming and classification
// ---------------------------------------------------------------------------
export function extensionOf(name: string): string {
  const text = String(name || '').trim();
  const dot = text.lastIndexOf('.');
  if (dot <= 0 || dot === text.length - 1) return '';
  const ext = text.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,16}$/.test(ext) ? ext : '';
}

export function mimeFor(ext: string, fallback = ''): string {
  return MIME_BY_EXT[String(ext || '').toLowerCase()] || fallback || 'application/octet-stream';
}

export function kindOf(nameOrExt: string, mime = ''): VaultKind {
  const ext = nameOrExt.includes('.') ? extensionOf(nameOrExt) : String(nameOrExt || '').toLowerCase();
  const byExt = KIND_BY_EXT[ext];
  if (byExt) return byExt;
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('text/')) return 'text';
  if (mime === 'application/pdf') return 'pdf';
  return 'other';
}

export function isOpenSupported(ext: string): boolean {
  return OPEN_EXTENSIONS.has(String(ext || '').toLowerCase());
}

/** A display name: no separators, no control characters, bounded at 180. */
export function sanitizeName(name: string): string {
  const clean = String(name || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)
    .trim();
  return clean;
}

export function normalizeTags(input: unknown): string[] {
  const rows = Array.isArray(input) ? input : String(input ?? '').split(',');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of rows) {
    const tag = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, MAX_TAG_LENGTH);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

export function normalizeNotes(value: unknown): string {
  return String(value ?? '').slice(0, MAX_NOTES_LENGTH);
}

export function newDocumentId(): string {
  return `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function newFolderId(): string {
  return `fld-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------
function isFolder(row: unknown): row is VaultFolder {
  const value = row as Partial<VaultFolder> | null;
  return Boolean(value && typeof value.id === 'string' && typeof value.name === 'string');
}

export function listFolders(projectId: string = getActiveProject()): VaultFolder[] {
  const rows = readScoped<unknown>(VAULT_FOLDERS_KEY, [], projectId);
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(isFolder)
    .map((folder) => ({
      id: folder.id,
      name: folder.name,
      parentId: folder.parentId ?? null,
      createdAt: folder.createdAt || '',
      updatedAt: folder.updatedAt || folder.createdAt || '',
      // A rebuilt row must carry the flag, or every read would forget that a
      // folder is the one DSR owns.
      ...(folder.system ? { system: folder.system } : {}),
      ...(folder.systemKey ? { systemKey: folder.systemKey } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function saveFolders(folders: VaultFolder[], projectId: string): void {
  writeScopedStrict(VAULT_FOLDERS_KEY, folders, projectId);
}

function folderNameProblem(name: string): string | null {
  const clean = sanitizeName(name);
  if (!clean) return 'Name the folder.';
  if (clean.length > 60) return 'Keep folder names under 60 characters.';
  return null;
}

export function createFolder(
  name: string,
  parentId: string | null = null,
  projectId: string = getActiveProject(),
  system?: VaultFolderSystem,
  systemKey?: string
): VaultFolder {
  const problem = folderNameProblem(name);
  if (problem) throw new Error(problem);
  const folders = listFolders(projectId);
  const clean = sanitizeName(name);
  if (parentId && !folders.some((folder) => folder.id === parentId)) {
    throw new Error('That parent folder no longer exists.');
  }
  const duplicate = folders.some(
    (folder) => folder.parentId === parentId && folder.name.toLowerCase() === clean.toLowerCase()
  );
  if (duplicate) throw new Error('A folder with that name already exists here.');
  if (
    system &&
    folders.some(
      (folder) =>
        folder.system === system &&
        folder.parentId === parentId &&
        (folder.systemKey ?? '') === (systemKey ?? '')
    )
  ) {
    throw new Error('That managed folder already exists here.');
  }
  const now = new Date().toISOString();
  const folder: VaultFolder = {
    id: newFolderId(),
    name: clean,
    parentId,
    createdAt: now,
    updatedAt: now,
    ...(system ? { system } : {}),
    ...(system && systemKey ? { systemKey } : {}),
  };
  saveFolders([...folders, folder], projectId);
  return folder;
}

/**
 * Stamp (or clear) the managed flag on a folder. Daily Site Reports uses this
 * to adopt a folder the person had already made with the same name instead of
 * creating a confusing duplicate beside it.
 */
export function setFolderSystem(
  id: string,
  system: VaultFolderSystem | null,
  projectId: string = getActiveProject(),
  systemKey?: string
): VaultFolder {
  const folders = listFolders(projectId);
  const target = folders.find((folder) => folder.id === id);
  if (!target) throw new Error('That folder no longer exists.');
  const next: VaultFolder = { ...target, updatedAt: new Date().toISOString() };
  if (system) next.system = system;
  else delete next.system;
  if (system && systemKey) next.systemKey = systemKey;
  else delete next.systemKey;
  saveFolders(folders.map((folder) => (folder.id === id ? next : folder)), projectId);
  return next;
}

export function renameFolder(
  id: string,
  name: string,
  projectId: string = getActiveProject()
): VaultFolder {
  const problem = folderNameProblem(name);
  if (problem) throw new Error(problem);
  const folders = listFolders(projectId);
  const target = folders.find((folder) => folder.id === id);
  if (!target) throw new Error('That folder no longer exists.');
  const clean = sanitizeName(name);
  const duplicate = folders.some(
    (folder) =>
      folder.id !== id &&
      folder.parentId === target.parentId &&
      folder.name.toLowerCase() === clean.toLowerCase()
  );
  if (duplicate) throw new Error('A folder with that name already exists here.');
  const updated: VaultFolder = { ...target, name: clean, updatedAt: new Date().toISOString() };
  saveFolders(folders.map((folder) => (folder.id === id ? updated : folder)), projectId);
  return updated;
}

/** True when `candidateParentId` is `folderId` or sits underneath it. */
export function isInsideFolder(
  folders: VaultFolder[],
  candidateParentId: string | null,
  folderId: string
): boolean {
  let cursor = candidateParentId;
  let guard = 0;
  while (cursor && guard < 100) {
    if (cursor === folderId) return true;
    cursor = folders.find((folder) => folder.id === cursor)?.parentId ?? null;
    guard += 1;
  }
  return false;
}

export function moveFolder(
  id: string,
  parentId: string | null,
  projectId: string = getActiveProject()
): VaultFolder {
  const folders = listFolders(projectId);
  const target = folders.find((folder) => folder.id === id);
  if (!target) throw new Error('That folder no longer exists.');
  if (parentId && !folders.some((folder) => folder.id === parentId)) {
    throw new Error('That folder no longer exists.');
  }
  if (parentId && isInsideFolder(folders, parentId, id)) {
    throw new Error('A folder cannot be moved inside itself.');
  }
  const duplicate = folders.some(
    (folder) =>
      folder.id !== id &&
      folder.parentId === parentId &&
      folder.name.toLowerCase() === target.name.toLowerCase()
  );
  if (duplicate) throw new Error('A folder with that name already exists there.');
  const updated: VaultFolder = { ...target, parentId, updatedAt: new Date().toISOString() };
  saveFolders(folders.map((folder) => (folder.id === id ? updated : folder)), projectId);
  return updated;
}

/**
 * Remove a folder. Its documents and subfolders move to the parent — nothing
 * is deleted, because a folder is a label, not a deletion tool.
 */
export function deleteFolder(
  id: string,
  projectId: string = getActiveProject()
): { documents: number; folders: number } {
  const folders = listFolders(projectId);
  const target = folders.find((folder) => folder.id === id);
  if (!target) throw new Error('That folder no longer exists.');
  if (target.system) {
    throw new Error(`${target.name} is managed by Daily Site Reports — move its files instead.`);
  }
  const now = new Date().toISOString();
  const nextFolders = folders
    .filter((folder) => folder.id !== id)
    .map((folder) =>
      folder.parentId === id ? { ...folder, parentId: target.parentId, updatedAt: now } : folder
    );
  let documents = 0;
  const docs = readDocuments(projectId).map((doc) => {
    const patch: Partial<VaultDocument> = {};
    if (doc.folderId === id) {
      patch.folderId = target.parentId;
      documents += 1;
    }
    if (doc.deletedFromFolderId === id) patch.deletedFromFolderId = target.parentId;
    return Object.keys(patch).length ? { ...doc, ...patch, updatedAt: now } : doc;
  });
  saveFolders(nextFolders, projectId);
  // Always written: a trashed document may point at the removed folder even
  // when no live document did.
  writeDocuments(docs, projectId);
  return { documents, folders: folders.filter((folder) => folder.parentId === id).length };
}

/** The chain of folder names, outermost first. */
export function folderPathNames(folders: VaultFolder[], folderId: string | null): string[] {
  const names: string[] = [];
  let cursor = folderId;
  let guard = 0;
  while (cursor && guard < 100) {
    const folder = folders.find((row) => row.id === cursor);
    if (!folder) break;
    names.unshift(folder.name);
    cursor = folder.parentId;
    guard += 1;
  }
  return names;
}

export function folderLabel(folders: VaultFolder[], folderId: string | null): string {
  if (!folderId) return 'Unsorted';
  const names = folderPathNames(folders, folderId);
  return names.length ? names.join(' / ') : 'Unsorted';
}

export function documentFolderLabel(folders: VaultFolder[], doc: VaultDocument): string {
  return folderLabel(folders, doc.folderId);
}

/** Find or create the nested folders implied by a dropped directory path. */
export function ensureFolderPath(
  names: string[],
  parentId: string | null,
  projectId: string = getActiveProject()
): string | null {
  let parent = parentId;
  for (const raw of names) {
    const name = sanitizeName(raw).slice(0, 60);
    if (!name) continue;
    const folders = listFolders(projectId);
    const existing = folders.find(
      (folder) => folder.parentId === parent && folder.name.toLowerCase() === name.toLowerCase()
    );
    parent = existing ? existing.id : createFolder(name, parent, projectId).id;
  }
  return parent;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------
function isDocument(row: unknown): row is VaultDocument {
  const value = row as Partial<VaultDocument> | null;
  return Boolean(
    value &&
      typeof value.id === 'string' &&
      typeof value.name === 'string' &&
      typeof value.sizeBytes === 'number'
  );
}

function readDocuments(projectId: string): VaultDocument[] {
  const rows = readScoped<unknown>(VAULT_DOCUMENTS_KEY, [], projectId);
  if (!Array.isArray(rows)) return [];
  return rows.filter(isDocument).map((doc) => ({
    ...doc,
    folderId: doc.folderId ?? null,
    ext: doc.ext || extensionOf(doc.name),
    kind: doc.kind || kindOf(doc.name, doc.mime),
    mime: doc.mime || mimeFor(doc.ext || extensionOf(doc.name)),
    tags: normalizeTags(doc.tags),
    notes: typeof doc.notes === 'string' ? doc.notes : '',
    thumb: doc.thumb ?? null,
  }));
}

function writeDocuments(docs: VaultDocument[], projectId: string): void {
  writeScopedStrict(VAULT_DOCUMENTS_KEY, docs, projectId);
}

export function listDocuments(projectId: string = getActiveProject()): VaultDocument[] {
  return readDocuments(projectId).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function activeDocuments(projectId: string = getActiveProject()): VaultDocument[] {
  return listDocuments(projectId).filter((doc) => !doc.deletedAt);
}

export function trashedDocuments(projectId: string = getActiveProject()): VaultDocument[] {
  return listDocuments(projectId).filter((doc) => Boolean(doc.deletedAt));
}

export function documentById(
  id: string,
  projectId: string = getActiveProject()
): VaultDocument | null {
  return readDocuments(projectId).find((doc) => doc.id === id) ?? null;
}

export type VaultDocumentPatch = Partial<
  Pick<VaultDocument, 'name' | 'folderId' | 'tags' | 'notes' | 'thumb'>
>;

export function updateDocument(
  id: string,
  patch: VaultDocumentPatch,
  projectId: string = getActiveProject()
): VaultDocument {
  const docs = readDocuments(projectId);
  const index = docs.findIndex((doc) => doc.id === id);
  if (index < 0) throw new Error('That file is no longer in the vault.');
  const current = docs[index];
  const next: VaultDocument = { ...current };
  if (typeof patch.name === 'string') {
    const name = sanitizeName(patch.name);
    if (!name) throw new Error('Give the file a name.');
    next.name = name;
    const ext = extensionOf(name);
    if (ext) {
      next.ext = ext;
      next.kind = kindOf(ext, next.mime);
      next.mime = mimeFor(ext, next.mime);
    }
  }
  if (patch.folderId !== undefined) {
    if (patch.folderId && !listFolders(projectId).some((folder) => folder.id === patch.folderId)) {
      throw new Error('That folder no longer exists.');
    }
    next.folderId = patch.folderId ?? null;
  }
  if (patch.tags !== undefined) next.tags = normalizeTags(patch.tags);
  if (patch.notes !== undefined) next.notes = normalizeNotes(patch.notes);
  if (patch.thumb !== undefined) next.thumb = patch.thumb;
  next.updatedAt = new Date().toISOString();
  docs[index] = next;
  writeDocuments(docs, projectId);
  return next;
}

export function trashDocument(id: string, projectId: string = getActiveProject()): VaultDocument {
  const docs = readDocuments(projectId);
  const index = docs.findIndex((doc) => doc.id === id);
  if (index < 0) throw new Error('That file is no longer in the vault.');
  if (docs[index].deletedAt) return docs[index];
  const now = new Date().toISOString();
  docs[index] = {
    ...docs[index],
    deletedAt: now,
    deletedFromFolderId: docs[index].folderId,
    updatedAt: now,
  };
  writeDocuments(docs, projectId);
  return docs[index];
}

export function restoreDocument(id: string, projectId: string = getActiveProject()): VaultDocument {
  const docs = readDocuments(projectId);
  const index = docs.findIndex((doc) => doc.id === id);
  if (index < 0) throw new Error('That file is no longer in the vault.');
  const folders = listFolders(projectId);
  const wanted = docs[index].deletedFromFolderId ?? null;
  const folderId = wanted && folders.some((folder) => folder.id === wanted) ? wanted : null;
  const restored: VaultDocument = { ...docs[index], folderId, updatedAt: new Date().toISOString() };
  delete restored.deletedAt;
  delete restored.deletedFromFolderId;
  docs[index] = restored;
  writeDocuments(docs, projectId);
  return restored;
}

/** Drop the metadata row without touching the file (used after a manual cleanup). */
export function purgeDocumentRecord(
  id: string,
  projectId: string = getActiveProject()
): void {
  writeDocuments(
    readDocuments(projectId).filter((doc) => doc.id !== id),
    projectId
  );
}

/** Permanently delete every trashed file and its metadata row. */
export async function emptyTrash(
  ctx: VaultContext,
  storage: VaultStorage = getVaultStorage()
): Promise<number> {
  const docs = readDocuments(ctx.projectId);
  const trashed = docs.filter((doc) => Boolean(doc.deletedAt));
  for (const doc of trashed) {
    try {
      await storage.remove(ctx, { docId: doc.id, ext: doc.ext, variant: 'file' });
    } catch {
      /* a file already gone is the desired state */
    }
  }
  writeDocuments(
    docs.filter((doc) => !doc.deletedAt),
    ctx.projectId
  );
  return trashed.length;
}

// ---------------------------------------------------------------------------
// Query / summary
// ---------------------------------------------------------------------------
export function queryDocuments(
  docs: VaultDocument[],
  options: VaultQuery = {},
  folders: VaultFolder[] = []
): { rows: VaultDocument[]; total: number; page: number; pages: number } {
  const query = String(options.query || '').trim().toLowerCase();
  const kind = options.kind && options.kind !== 'all' ? options.kind : null;
  const tag = options.tag ? options.tag.toLowerCase() : null;
  const folderFiltered = options.folderId !== undefined;
  const sort: VaultSort = options.sort || 'updated';

  const filtered = docs.filter((doc) => {
    if (!options.includeTrash && doc.deletedAt) return false;
    if (folderFiltered && (doc.folderId ?? null) !== (options.folderId ?? null)) return false;
    if (kind && doc.kind !== kind) return false;
    if (tag && !doc.tags.some((row) => row.toLowerCase() === tag)) return false;
    if (!query) return true;
    const folderName = folders.length ? folderLabel(folders, doc.folderId) : '';
    const haystack = `${doc.name} ${doc.tags.join(' ')} ${doc.notes} ${folderName}`.toLowerCase();
    return query.split(/\s+/).every((word) => haystack.includes(word));
  });

  filtered.sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name);
    if (sort === 'size') return b.sizeBytes - a.sizeBytes;
    if (sort === 'kind') return a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name);
    return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
  });

  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / VAULT_PAGE_SIZE));
  const page = Math.min(Math.max(1, options.page || 1), pages);
  const start = (page - 1) * VAULT_PAGE_SIZE;
  return { rows: filtered.slice(start, start + VAULT_PAGE_SIZE), total, page, pages };
}

/** Counts for the folder tree: `all`, `root` and one entry per folder id. */
export function folderCounts(docs: VaultDocument[]): Map<string, number> {
  const counts = new Map<string, number>();
  let all = 0;
  for (const doc of docs) {
    if (doc.deletedAt) continue;
    all += 1;
    const key = doc.folderId ?? 'root';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  counts.set('all', all);
  return counts;
}

export function vaultSummary(docs: VaultDocument[]): {
  files: number;
  bytes: number;
  byKind: Record<VaultKind, number>;
} {
  const byKind: Record<VaultKind, number> = {
    pdf: 0, word: 0, excel: 0, powerpoint: 0, image: 0, drawing: 0, archive: 0, text: 0, other: 0,
  };
  let files = 0;
  let bytes = 0;
  for (const doc of docs) {
    if (doc.deletedAt) continue;
    files += 1;
    bytes += Number(doc.sizeBytes) || 0;
    byKind[doc.kind] = (byKind[doc.kind] || 0) + 1;
  }
  return { files, bytes, byKind };
}

export function tagList(docs: VaultDocument[]): string[] {
  const tags = new Set<string>();
  for (const doc of docs) {
    if (doc.deletedAt) continue;
    for (const tag of doc.tags) tags.add(tag);
  }
  return [...tags].sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------
export interface VaultUploadInput {
  file: File;
  ctx: VaultContext;
  folderId?: string | null;
  tags?: string[];
  notes?: string;
  storage?: VaultStorage;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

export interface VaultUploadResult {
  document: VaultDocument;
  duplicate: boolean;
}

function abortError(): Error {
  const error = new Error('Upload cancelled.');
  error.name = 'AbortError';
  return error;
}

async function uploadThumbnail(
  storage: VaultStorage,
  ctx: VaultContext,
  docId: string,
  dataUrl: string,
  dimensions: VaultThumb
): Promise<VaultThumb | null> {
  const body = dataUrlBody(dataUrl);
  if (!body) return null;
  try {
    const totalBytes = base64Bytes(body);
    await storage.begin(ctx, {
      docId,
      ext: 'jpg',
      variant: 'thumb',
      totalChunks: 1,
      totalBytes,
    });
    await storage.chunk(ctx, {
      docId,
      variant: 'thumb',
      chunkIndex: 0,
      dataBase64: body,
    });
    await storage.finish(ctx, { docId, variant: 'thumb' });
    return dimensions;
  } catch {
    // A thumbnail is a convenience; the document itself must still be saved.
    try {
      await storage.abort(ctx, { docId, variant: 'thumb' });
    } catch {
      /* ignore */
    }
    return null;
  }
}

/**
 * Build and store a thumbnail after the document already exists, then patch
 * the metadata row. Failures are silent by design: the file is what matters.
 */
async function attachThumbnail(
  storage: VaultStorage,
  ctx: VaultContext,
  docId: string,
  file: File
): Promise<void> {
  const thumbnail = await makeThumbnail(file);
  if (!thumbnail) return;
  const thumb = await uploadThumbnail(storage, ctx, docId, thumbnail.dataUrl, {
    width: thumbnail.width,
    height: thumbnail.height,
  });
  if (!thumb) return;
  try {
    updateDocument(docId, { thumb }, ctx.projectId);
  } catch {
    /* the row may have been removed while the thumbnail was being made */
  }
}

export async function uploadDocument(input: VaultUploadInput): Promise<VaultUploadResult> {
  const { file, ctx } = input;
  const storage = input.storage ?? getVaultStorage();
  if (!ctx.userId || !ctx.projectId) {
    throw new Error('Sign in and open a job before adding files.');
  }
  if (!file || file.size <= 0) {
    throw new Error('That file is empty — there is nothing to store.');
  }
  if (file.size > MAX_VAULT_FILE_BYTES) {
    throw new Error(
      `Files are limited to ${formatBytes(MAX_VAULT_FILE_BYTES)} — “${file.name}” is ${formatBytes(file.size)}.`
    );
  }
  const name = sanitizeName(file.name) || 'document';
  const ext = extensionOf(name) || 'bin';
  const kind = kindOf(name, file.type);
  const mime = file.type || mimeFor(ext);
  const folderId = input.folderId ?? null;
  if (folderId && !listFolders(ctx.projectId).some((folder) => folder.id === folderId)) {
    throw new Error('That folder no longer exists.');
  }

  const docId = newDocumentId();
  const totalChunks = Math.max(1, Math.ceil(file.size / VAULT_CHUNK_BYTES));
  await storage.begin(ctx, {
    docId,
    ext,
    variant: 'file',
    totalChunks,
    totalBytes: file.size,
  });

  try {
    for (let index = 0; index < totalChunks; index += 1) {
      if (input.signal?.aborted) throw abortError();
      const start = index * VAULT_CHUNK_BYTES;
      const end = Math.min(file.size, start + VAULT_CHUNK_BYTES);
      const buffer = await file.slice(start, end).arrayBuffer();
      const dataBase64 = bytesToBase64(new Uint8Array(buffer));
      try {
        await storage.chunk(ctx, { docId, variant: 'file', chunkIndex: index, dataBase64 });
      } catch {
        if (input.signal?.aborted) throw abortError();
        // One retry: a transient IPC failure should not lose a 200 MB upload.
        await storage.chunk(ctx, { docId, variant: 'file', chunkIndex: index, dataBase64 });
      }
      input.onProgress?.(Math.min(90, Math.round(((index + 1) / totalChunks) * 90)));
    }
    const written = await storage.finish(ctx, { docId, variant: 'file' });
    if (written.sizeBytes !== file.size) {
      throw new Error('The file did not save completely. Try again.');
    }

    const now = new Date().toISOString();
    const docs = readDocuments(ctx.projectId);
    const duplicate = docs.some(
      (doc) =>
        !doc.deletedAt &&
        doc.checksum === written.checksum &&
        doc.sizeBytes === written.sizeBytes &&
        (doc.folderId ?? null) === folderId
    );
    const document: VaultDocument = {
      id: docId,
      folderId,
      name,
      ext,
      mime,
      kind,
      sizeBytes: written.sizeBytes,
      checksum: written.checksum,
      createdAt: now,
      updatedAt: now,
      tags: normalizeTags(input.tags),
      notes: normalizeNotes(input.notes),
      thumb: null,
    };
    try {
      writeDocuments([...docs, document], ctx.projectId);
    } catch {
      try {
        await storage.remove(ctx, { docId, ext, variant: 'file' });
      } catch {
        /* best effort: the record was never written */
      }
      throw new Error('The vault’s index is full — the file was not added. Take a backup and free space.');
    }
    input.onProgress?.(100);
    // A thumbnail is decoration, never a gate: make it after the document is
    // safe, and keep it out of the upload's success path.
    void attachThumbnail(storage, ctx, docId, file).catch(() => undefined);
    return { document, duplicate };
  } catch (error) {
    try {
      await storage.abort(ctx, { docId, variant: 'file' });
    } catch {
      /* nothing to abort */
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Reading state
// ---------------------------------------------------------------------------
export async function availability(
  ctx: VaultContext,
  doc: VaultDocument,
  storage: VaultStorage = getVaultStorage()
): Promise<boolean> {
  try {
    return await storage.exists(ctx, { docId: doc.id, ext: doc.ext, variant: 'file' });
  } catch {
    return false;
  }
}

export interface VaultPreview {
  status: 'ready' | 'none' | 'missing';
  kind?: 'image' | 'text';
  dataUrl?: string;
  text?: string;
  truncated?: boolean;
  reason?: string;
}

export async function readPreview(
  ctx: VaultContext,
  doc: VaultDocument,
  storage: VaultStorage = getVaultStorage()
): Promise<VaultPreview> {
  const present = await availability(ctx, doc, storage);
  if (!present) {
    return { status: 'missing', reason: 'That file is missing from this computer.' };
  }
  if (doc.kind === 'image') {
    if (doc.sizeBytes > MAX_INLINE_PREVIEW_BYTES) {
      return { status: 'none', reason: 'This image is too large to preview here. Open it with its own app.' };
    }
    try {
      const base64 = await storage.readBase64(ctx, {
        docId: doc.id,
        ext: doc.ext,
        variant: 'file',
      });
      if (!base64) {
        return { status: 'missing', reason: 'That file is missing from this computer.' };
      }
      return { status: 'ready', kind: 'image', dataUrl: `data:${doc.mime || 'image/jpeg'};base64,${base64}` };
    } catch (error) {
      return {
        status: 'none',
        reason: error instanceof Error ? error.message : 'That image could not be previewed.',
      };
    }
  }
  const textLike = TEXT_EXTENSIONS.has(doc.ext) || doc.mime.startsWith('text/');
  if (textLike) {
    try {
      const base64 = await storage.readBase64(ctx, {
        docId: doc.id,
        ext: doc.ext,
        variant: 'file',
      });
      if (!base64) {
        return { status: 'missing', reason: 'That file is missing from this computer.' };
      }
      const full = base64ToText(base64);
      const limit = 64 * 1024;
      return {
        status: 'ready',
        kind: 'text',
        text: full.slice(0, limit),
        truncated: full.length > limit,
      };
    } catch (error) {
      return {
        status: 'none',
        reason: error instanceof Error ? error.message : 'That file could not be previewed.',
      };
    }
  }
  return {
    status: 'none',
    reason: 'This format has no inline preview. Open it with its own app.',
  };
}

export async function documentFolderPath(
  ctx: VaultContext,
  storage: VaultStorage = getVaultStorage()
): Promise<string | null> {
  if (!storage.folderPath) return null;
  try {
    return await storage.folderPath(ctx);
  } catch {
    return null;
  }
}

export async function purgeVaultForUser(
  userId: string,
  storage: VaultStorage = getVaultStorage()
): Promise<number> {
  if (!storage.purgeUser) return 0;
  try {
    return await storage.purgeUser(userId);
  } catch {
    return 0;
  }
}
