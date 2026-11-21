// ============================================================================
// attachmentService — documents attached to ledger entries.
//
// The file itself is still stored by ledgerService.saveAttachment() (the same
// offline blob map, so existing backups keep working). This module adds what was
// missing around it:
//
//   • validation — images and PDF only, a hard size ceiling, real MIME type,
//   • metadata   — original filename, MIME, size, checksum, upload time,
//   • a link     — entry ↔ document rows, additive and multi-document ready,
//   • cleanup    — removing a document deletes its blob, metadata and links.
//
// Entries written before this module have no link rows; they are read from
// `entry.attachment` instead, so old records still show their document.
// ============================================================================
import { ATTACH_KEY, readAttachment, saveAttachment } from './ledgerService';
import { readScoped, writeScopedStrict } from './projectScope';
import { formatBytes } from './staffService';

export const ATTACHMENT_META_KEY = 'contractoros_ledger_attachment_meta';
export const ENTRY_DOCUMENTS_KEY = 'contractoros_entry_documents';

/** A scanned bill or receipt; 5 MB is generous for a phone photo. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** Stored files are never rendered as markup — only images and PDFs. */
export const ALLOWED_MIME: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'application/pdf',
]);

export interface AttachmentInput {
  fileName: string;
  mimeType?: string;
  dataUrl: string;
  sizeBytes?: number;
}

export interface DocumentMeta {
  path: string;
  fileName: string; // original name as the user picked it
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  uploadedAt: string;
}

export interface EntryDocument extends DocumentMeta {
  /** The stored file, or '' when the blob is missing (never fabricated). */
  dataUrl: string;
  available: boolean;
}

export interface EntryDocumentLink {
  id: string;
  entry_id: string;
  path: string;
  added_at: string;
}

// Attachment metadata and entry links belong to the job whose books they
// document — never to the machine or to another job.
function readJSON<T>(key: string, fallback: T): T {
  return readScoped<T>(key, fallback);
}

function writeJSON(key: string, value: unknown) {
  // Strict: an attachment is stored inside the entry's atomic save.
  writeScopedStrict(key, value);
}

/** `data:image/png;base64,…` → `image/png`. */
export function mimeFromDataUrl(dataUrl: string): string {
  const match = /^data:([^;,]+)[;,]/.exec(String(dataUrl || ''));
  return match ? match[1].toLowerCase() : '';
}

/** Decoded byte length of a base64 data URL. */
export function dataUrlBytes(dataUrl: string): number {
  const raw = String(dataUrl || '');
  const comma = raw.indexOf(',');
  if (comma < 0) return 0;
  const body = raw.slice(comma + 1);
  const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((body.length * 3) / 4) - padding);
}

/**
 * FNV-1a — the same fingerprint the backup manifest uses (backupService), kept
 * local so the ledger never pulls the zip/backup engine into its bundle.
 */
export function checksumOfText(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export type ValidatedAttachment = Omit<DocumentMeta, 'path'>;

/**
 * Validate a picked file. Throws a user-facing message — the caller shows it and
 * nothing is stored, so a rejected file can never leave anything behind.
 */
export function validateAttachment(input: AttachmentInput): ValidatedAttachment {
  const dataUrl = String(input?.dataUrl || '');
  if (!dataUrl.startsWith('data:')) throw new Error('That file could not be read — choose it again.');
  const mimeType = String(input.mimeType || mimeFromDataUrl(dataUrl) || '').toLowerCase();
  if (!ALLOWED_MIME.has(mimeType)) {
    throw new Error('Only images (PNG, JPG, WEBP, GIF) and PDF files can be attached.');
  }
  const fileName = String(input.fileName || '').trim() || 'document';
  const sizeBytes = Number(input.sizeBytes) > 0 ? Math.round(Number(input.sizeBytes)) : dataUrlBytes(dataUrl);
  if (sizeBytes > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment must be under ${formatBytes(MAX_ATTACHMENT_BYTES)} — this file is ${formatBytes(sizeBytes)}.`);
  }
  return { fileName, mimeType, sizeBytes, checksum: checksumOfText(dataUrl), uploadedAt: new Date().toISOString() };
}

function dropBlob(path: string) {
  const blobs = readJSON<Record<string, string>>(ATTACH_KEY, {});
  if (Object.prototype.hasOwnProperty.call(blobs, path)) {
    delete blobs[path];
    writeJSON(ATTACH_KEY, blobs);
  }
}

/** Store a validated file. Returns the generated path and its metadata. */
export function storeDocument(input: AttachmentInput): { path: string; meta: DocumentMeta } {
  const validated = validateAttachment(input);
  const path = saveAttachment(validated.fileName, input.dataUrl);
  try {
    const all = readJSON<Record<string, DocumentMeta>>(ATTACHMENT_META_KEY, {});
    const meta: DocumentMeta = { ...validated, path };
    all[path] = meta;
    writeJSON(ATTACHMENT_META_KEY, all);
    return { path, meta };
  } catch (err) {
    dropBlob(path); // no orphan: metadata and blob are stored together
    throw err;
  }
}

/** Delete a stored file, its metadata and every link that points at it. */
export function removeDocument(path: string) {
  if (!path) return;
  dropBlob(path);
  const metas = readJSON<Record<string, DocumentMeta>>(ATTACHMENT_META_KEY, {});
  if (Object.prototype.hasOwnProperty.call(metas, path)) {
    delete metas[path];
    writeJSON(ATTACHMENT_META_KEY, metas);
  }
  const links = readJSON<EntryDocumentLink[]>(ENTRY_DOCUMENTS_KEY, []);
  const kept = links.filter((link) => link.path !== path);
  if (kept.length !== links.length) writeJSON(ENTRY_DOCUMENTS_KEY, kept);
}

/** Link an entry to a stored document (no duplicates). */
export function linkDocument(entryId: string, path: string) {
  if (!entryId || !path) return;
  const links = readJSON<EntryDocumentLink[]>(ENTRY_DOCUMENTS_KEY, []);
  if (links.some((link) => link.entry_id === entryId && link.path === path)) return;
  links.push({ id: `doc-${Date.now()}-${links.length}`, entry_id: entryId, path, added_at: new Date().toISOString() });
  writeJSON(ENTRY_DOCUMENTS_KEY, links);
}

/** Remove every link row for one entry (used when its document is replaced). */
export function unlinkEntryDocuments(entryId: string) {
  const links = readJSON<EntryDocumentLink[]>(ENTRY_DOCUMENTS_KEY, []);
  const kept = links.filter((link) => link.entry_id !== entryId);
  if (kept.length !== links.length) writeJSON(ENTRY_DOCUMENTS_KEY, kept);
}

/**
 * The documents of an entry. New records are read from the link table; records
 * written before it existed fall back to `entry.attachment`. Only files that are
 * actually present are returned — a missing blob is reported honestly, never
 * invented.
 */
export function documentsForEntry(entry: { id: string; attachment?: string } | null | undefined): EntryDocument[] {
  if (!entry || !entry.id) return [];
  const links = readJSON<EntryDocumentLink[]>(ENTRY_DOCUMENTS_KEY, []).filter((link) => link.entry_id === entry.id);
  const paths = links.length > 0 ? links.map((link) => link.path) : entry.attachment ? [entry.attachment] : [];
  const metas = readJSON<Record<string, DocumentMeta>>(ATTACHMENT_META_KEY, {});
  const seen = new Set<string>();
  const out: EntryDocument[] = [];
  for (const path of paths) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const dataUrl = readAttachment(path) || '';
    const meta = metas[path];
    out.push({
      path,
      fileName: meta?.fileName || path.split('/').pop() || 'Document',
      mimeType: meta?.mimeType || mimeFromDataUrl(dataUrl),
      sizeBytes: meta?.sizeBytes ?? (dataUrl ? dataUrlBytes(dataUrl) : 0),
      checksum: meta?.checksum || (dataUrl ? checksumOfText(dataUrl) : ''),
      uploadedAt: meta?.uploadedAt || '',
      dataUrl,
      available: Boolean(dataUrl),
    });
  }
  return out;
}
