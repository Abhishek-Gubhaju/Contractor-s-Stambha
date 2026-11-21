// ============================================================================
// Backup engine — Stambha/<project>/<feature>/…
//
// Manual backups only, and nothing is ever deleted: every run writes a new
// timestamped file per feature plus a manifest that maps each file back to the
// exact storage key (and project) it came from. That manifest is what restore
// trusts, so a folder can be restored without guessing.
//
// Two destinations behind one call:
//   • desktop app  → ~/Documents/Stambha/… (native command, no prompts)
//   • browser      → the same tree inside a downloaded .zip
// ============================================================================
import JSZip from 'jszip';
import {
  getActiveProject,
  normalizeProjectId,
  readScoped,
  scopeOwner,
  scopedKey,
} from '../projectScope';
import { COST_CODES_KEY, PROJECTS_KEY, loadProjects, type Project } from '../masterData';
import { backupSnapshot } from '../ledgerService';
import { COMPANY_KEY } from '../companyService';
import { PARTIES_KEY } from '../partyService';
import { DOC_ITEMS_KEY } from '../documentService';
import { activeUser } from '../auth/authService';
import { VAULT_DOCUMENTS_KEY, VAULT_FOLDERS_KEY } from '../vault/vaultService';
import { vaultBackupCopy, vaultRestoreCopy } from '../vault/desktopVault';
import { isDesktopApp, saveBackupFilesNative } from './desktop';
import { backupLocationForNative } from './backupLocation';

export const BACKUP_ROOT = 'Stambha';
export const COMPANY_FOLDER = '_Company';
export const BACKUP_FORMAT_VERSION = 2;
/** Oldest format this build can still read (v1 had no checksums). */
export const MIN_BACKUP_FORMAT_VERSION = 1;
export const PRE_RESTORE_KEY = 'contractoros_pre_restore';
export const LAST_BACKUP_KEY = 'contractoros_last_backup';

export interface BackupFile {
  path: string; // relative to BACKUP_ROOT, e.g. "PRJ-001_Sample/BOQ/boq-2026…json"
  content: string;
}

export interface BackupEntry {
  path: string;
  key: string;
  projectId?: string;
  restorable: boolean;
  bytes: number;
  count: number;
  /** Cheap content fingerprint so a damaged file is caught before restore. */
  checksum?: string;
}

export interface BackupManifest {
  /** Written by this build; the other values come from earlier builds. */
  app: 'stambha' | 'sthamba' | 'contractorOS';
  version: number;
  runId: string;
  createdAt: string;
  /** Whose books this backup holds. Absent on pre-account backups. */
  user?: { id: string; username: string; displayName: string } | null;
  projects: { id: string; name: string; folder: string }[];
  files: BackupEntry[];
  totals: { files: number; bytes: number };
}

export interface BackupResult {
  mode: 'desktop' | 'download';
  runId: string;
  fileCount: number;
  bytes: number;
  location: string;
  /** Vault documents copied into the run (desktop only). */
  vaultFiles?: number;
  vaultBytes?: number;
  /** A vault copy that failed does not invalidate the books backup. */
  vaultError?: string;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** One folder per feature inside each project. */
interface ProjectFeature {
  folder: string;
  base: string;
  file: string;
}

const PROJECT_FEATURES: ProjectFeature[] = [
  { folder: 'BOQ', base: 'contractoros_boq', file: 'boq' },
  { folder: 'DSR', base: 'contractoros_dsr', file: 'dsr' },
  { folder: 'DSR', base: 'contractoros_dsr_deleted', file: 'dsr-deleted' },
  { folder: 'Work Progress', base: 'contractoros_milestones', file: 'milestones' },
  { folder: 'Procurement', base: 'contractoros_po', file: 'purchase-orders' },
  { folder: 'Billing', base: 'contractoros_billing_entries', file: 'billing' },
  { folder: 'Labour', base: 'contractoros_labor', file: 'workers' },
  { folder: 'Labour', base: 'contractoros_labor_deleted', file: 'workers-deleted' },
  { folder: 'Labour', base: 'contractoros_worker_rates', file: 'worker-rates' },
  { folder: 'Attendance', base: 'contractoros_attendance', file: 'attendance' },
  { folder: 'Payroll', base: 'contractoros_labour_tx', file: 'transactions' },
  { folder: 'Payroll', base: 'contractoros_payroll_runs', file: 'runs' },
  { folder: 'Staff', base: 'contractoros_staff', file: 'staff' },
  { folder: 'Staff', base: 'contractoros_staff_deleted', file: 'staff-deleted' },
  { folder: 'Staff', base: 'contractoros_staff_attendance', file: 'staff-attendance' },
  { folder: 'Gantt', base: 'contractoros_gantt_activities', file: 'activities' },
  { folder: 'Gantt', base: 'contractoros_gantt_dependencies', file: 'dependencies' },
  // ── Ledger / finance (one complete set per job) ─────────────────────────
  { folder: 'Ledger', base: 'contractoros_entries', file: 'entries' },
  { folder: 'Ledger', base: 'contractoros_entry_lines', file: 'entry-lines' },
  { folder: 'Ledger', base: 'contractoros_accounts', file: 'accounts' },
  { folder: 'Ledger', base: 'contractoros_bill_links', file: 'bill-links' },
  { folder: 'Ledger', base: 'contractoros_books_meta', file: 'books-meta' },
  // Scanned bills/receipts attached to entries. These are the only copy of the
  // source documents, so a backup without them cannot rebuild the file on a new
  // machine — they are restorable like any other job data.
  { folder: 'Ledger', base: 'contractoros_ledger_attachments', file: 'attachments' },
  // Document metadata and the entry↔document links that point into those
  // blobs. Older backups simply do not contain them; restore only writes the
  // files a manifest lists, so those backups stay restorable.
  { folder: 'Ledger', base: 'contractoros_ledger_attachment_meta', file: 'attachment-meta' },
  { folder: 'Ledger', base: 'contractoros_entry_documents', file: 'entry-documents' },
  { folder: 'Ledger', base: 'contractoros_ledger_entries', file: 'legacy-entries' },
  { folder: 'Ledger', base: 'contractoros_ledger_meta', file: 'legacy-meta' },
  // ── Masters and identity of this job ───────────────────────────────────
  // The printed letterhead (name, PAN, address, logo) and the client/vendor
  // master. Each job/company keeps its own, so a restore cannot stamp one
  // company's identity onto another company's bills.
  { folder: 'Settings', base: COMPANY_KEY, file: 'company-profile' },
  { folder: 'Masters', base: PARTIES_KEY, file: 'parties' },
  { folder: 'Masters', base: COST_CODES_KEY, file: 'cost-codes' },
  { folder: 'Settings', base: 'contractoros_settings', file: 'company-settings' },
  { folder: 'Settings', base: 'contractoros_tax_settings', file: 'tax-settings' },
  { folder: 'Commitments', base: 'contractoros_commitments', file: 'commitments' },
  // Bill/invoice lines: the quantities and rates behind every posted document.
  { folder: 'Billing', base: DOC_ITEMS_KEY, file: 'document-items' },
  { folder: 'Inventory', base: 'contractoros_stock_items', file: 'items' },
  { folder: 'Inventory', base: 'contractoros_stock_movements', file: 'movements' },
  // File Vault metadata. The bytes themselves are copied into the same run's
  // `Vault/` folder by the native command, so the manifest and the files a
  // restore needs arrive together.
  { folder: 'Vault', base: VAULT_DOCUMENTS_KEY, file: 'documents' },
  { folder: 'Vault', base: VAULT_FOLDERS_KEY, file: 'folders' },
  // Reminders are derived, but the inbox and the rules chosen travel with the
  // job: a restored machine must not lose preferences or re-alert old items.
  { folder: 'Notifications', base: 'contractoros_notifications', file: 'inbox' },
  { folder: 'Notifications', base: 'contractoros_notification_prefs', file: 'prefs' },
  { folder: 'Notifications', base: 'contractoros_notification_state', file: 'state' },
];

/** Machine-level data that is deliberately shared by every job. */
const COMPANY_FEATURES: ProjectFeature[] = [
  { folder: 'Settings', base: 'contractoros_settings_timezone', file: 'timezone' },
  { folder: 'Masters', base: PROJECTS_KEY, file: 'projects' },
];

/** Bases that now belong to a job (a v1/v2 backup stored them once, unscoped). */
const PROJECT_SCOPED_BASES: ReadonlySet<string> = new Set(PROJECT_FEATURES.map((feature) => feature.base));

/**
 * The only storage keys a restore may ever write.
 *
 * A manifest is just a file: without this list a crafted backup could claim
 * `contractoros_auth_users` and inject an admin account. Restore refuses any
 * key that is not business data listed here.
 */
export const RESTORABLE_KEYS: ReadonlySet<string> = new Set(
  [...PROJECT_FEATURES, ...COMPANY_FEATURES].map((feature) => feature.base)
);

/** Keys whose stored form is not JSON (a bare timezone string). */
const RAW_VALUE_KEYS: ReadonlySet<string> = new Set(['contractoros_settings_timezone']);

/** Strip anything a filesystem would reject and keep names readable. */
export function sanitizeSegment(value: string, fallback = 'untitled'): string {
  const clean = String(value || '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  return clean || fallback;
}

export interface BackupIdentity {
  id: string;
  username: string;
  displayName: string;
}

/**
 * Whose backup this is. Read from the live session so a backup can never be
 * written into (or restored over) the wrong person's folder.
 */
export function activeBackupUser(): BackupIdentity | null {
  try {
    const user = activeUser();
    return user ? { id: user.id, username: user.username, displayName: user.displayName } : null;
  } catch {
    return null;
  }
}

/** Stambha/<username> for a signed-in account, Stambha otherwise. */
export function backupRootFor(identity: BackupIdentity | null): string {
  if (!identity) return BACKUP_ROOT;
  return `${BACKUP_ROOT}/${sanitizeSegment(identity.username, identity.id)}`;
}

export function projectFolder(project: Project): string {
  return `${sanitizeSegment(project.id, 'project')}_${sanitizeSegment(project.name, project.id)}`;
}

export function runStamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  // Milliseconds are part of the stamp: two backups in the same second used
  // to write identical filenames and silently overwrite the earlier run.
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}-${String(date.getMilliseconds()).padStart(3, '0')}`;
}

const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

/** Real byte length (UTF-8), not JavaScript's UTF-16 character count. */
export function byteLength(text: string): number {
  return textEncoder ? textEncoder.encode(text).length : text.length * 2;
}

/** FNV-1a: small, dependency-free fingerprint for "is this file intact?". */
export function checksumOf(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const countOf = (doc: unknown): number => {
  if (Array.isArray(doc)) return doc.length;
  if (doc && typeof doc === 'object') return Object.keys(doc as object).length;
  return doc === null || doc === undefined ? 0 : 1;
};

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

let lastStampMs = 0;

/** Never hand out the same run id twice, even inside one millisecond. */
function uniqueRunStamp(now: Date): string {
  const ms = Math.max(now.getTime(), lastStampMs + 1);
  lastStampMs = ms;
  return runStamp(new Date(ms));
}

export function buildBackup(now = new Date(), identityOverride?: BackupIdentity | null): { files: BackupFile[]; manifest: BackupManifest; runId: string } {
  const runId = uniqueRunStamp(now);
  const createdAt = now.toISOString();
  const identity = identityOverride === undefined ? activeBackupUser() : identityOverride;
  const root = backupRootFor(identity);
  const projects = loadProjects();
  const files: BackupFile[] = [];
  const entries: BackupEntry[] = [];

  const put = (path: string, content: string, key: string, projectId: string | undefined, restorable: boolean, count: number) => {
    files.push({ path, content });
    entries.push({ path, key, projectId, restorable, bytes: byteLength(content), count, checksum: checksumOf(content) });
  };

  for (const project of projects) {
    const folder = `${root}/${projectFolder(project)}`;
    const projectId = normalizeProjectId(project.id);

    for (const feature of PROJECT_FEATURES) {
      const doc = readScoped<any>(feature.base, [], projectId);
      if (countOf(doc) === 0) continue;
      const content = JSON.stringify(doc, null, 2);
      put(`${folder}/${feature.folder}/${feature.file}-${runId}.json`, content, feature.base, projectId, true, countOf(doc));
    }

  }

  for (const feature of COMPANY_FEATURES) {
    const raw = readRaw(feature.base);
    if (raw === null) continue;
    let parsed: unknown = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* keep the raw string (e.g. a plain timezone value) */
    }
    put(
      `${root}/${COMPANY_FOLDER}/${feature.folder}/${feature.file}-${runId}.json`,
      typeof parsed === 'string' ? raw : JSON.stringify(parsed, null, 2),
      feature.base,
      undefined,
      true,
      countOf(parsed),
    );
  }

  // The all-in-one snapshot stays available as the last-resort recovery file.
  try {
    put(
      `${root}/${COMPANY_FOLDER}/Full/full-${runId}.json`,
      backupSnapshot(),
      '',
      undefined,
      false,
      countOf(projects),
    );
  } catch {
    /* snapshot helper unavailable in this context */
  }

  const manifest: BackupManifest = {
    app: 'stambha',
    version: BACKUP_FORMAT_VERSION,
    runId,
    createdAt,
    user: identity ? { id: identity.id, username: identity.username, displayName: identity.displayName } : null,
    projects: projects.map((p) => ({ id: normalizeProjectId(p.id), name: p.name, folder: projectFolder(p) })),
    files: entries,
    totals: { files: 0, bytes: 0 },
  };

  // Totals describe everything actually written, manifest copies included.
  // The manifest contains its own totals, so settle the byte count with a few
  // passes until it stops changing (digit widths are the only thing shifting).
  const dataBytes = files.reduce((sum, file) => sum + byteLength(file.content), 0);
  const dataFiles = files.length;
  manifest.totals = { files: dataFiles + 2, bytes: dataBytes };
  let manifestJson = JSON.stringify(manifest, null, 2);
  for (let pass = 0; pass < 3; pass += 1) {
    const nextBytes = dataBytes + byteLength(manifestJson) * 2;
    if (nextBytes === manifest.totals.bytes) break;
    manifest.totals.bytes = nextBytes;
    manifestJson = JSON.stringify(manifest, null, 2);
  }
  files.push({ path: `${root}/manifest-${runId}.json`, content: manifestJson });
  files.push({ path: `${root}/latest-manifest.json`, content: manifestJson });

  return { files, manifest, runId };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export async function zipBackup(files: BackupFile[]): Promise<Blob> {
  const zip = new JSZip();
  for (const file of files) zip.file(file.path, file.content);
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in WebKit; give it a moment.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function rememberLast(result: BackupResult) {
  try {
    localStorage.setItem(LAST_BACKUP_KEY, JSON.stringify(result));
  } catch {
    /* storage full/blocked — the backup itself already succeeded */
  }
}

/**
 * Copy every project's vault documents into the run that was just written.
 * Files are copied natively (never through the webview), so a 500 MB drawing
 * costs no IPC payload. A failure is reported but never discards the books
 * backup that already succeeded.
 */
async function copyVaultIntoRun(
  location: string,
  manifest: BackupManifest
): Promise<{ files: number; bytes: number; error?: string }> {
  if (!isDesktopApp()) return { files: 0, bytes: 0 };
  const user = activeBackupUser();
  if (!user) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  const errors: string[] = [];
  for (const project of manifest.projects) {
    // One snapshot per run: restoring an older manifest must bring back the
    // vault files that belonged to that run, not whatever the latest copy is.
    const destination = `${location}/${project.folder}/Vault/${manifest.runId}`;
    try {
      const info = await vaultBackupCopy(
        { userId: user.id, projectId: normalizeProjectId(project.id) },
        destination
      );
      files += info.files;
      bytes += info.bytes;
    } catch (error) {
      errors.push(
        `${project.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return { files, bytes, error: errors.length ? errors.join('; ') : undefined };
}

/** Merge a run's vault copies back for every job it contains. */
async function restoreVaultFromRun(
  runFolder: string,
  manifest: BackupManifest,
  runId: string
): Promise<{ restored: number; skipped: number; error?: string }> {
  if (!isDesktopApp()) return { restored: 0, skipped: 0 };
  const user = activeBackupUser();
  if (!user) return { restored: 0, skipped: 0 };
  let restored = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (const project of manifest.projects) {
    const source = `${runFolder}/${project.folder}/Vault/${runId}`;
    try {
      const info = await vaultRestoreCopy(
        { userId: user.id, projectId: normalizeProjectId(project.id) },
        source
      );
      restored += info.restored;
      skipped += info.skipped;
    } catch (error) {
      errors.push(
        `${project.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return { restored, skipped, error: errors.length ? errors.join('; ') : undefined };
}

/** Manual backup: native folder in the desktop app, ZIP download in a browser. */
export async function runBackup(): Promise<BackupResult> {
  const { files, manifest } = buildBackup();
  if (isDesktopApp()) {
    const location = await saveBackupFilesNative(
      files.map((f) => ({ path: f.path, content: f.content })),
      backupLocationForNative()
    );
    const vault = await copyVaultIntoRun(location, manifest);
    const result: BackupResult = {
      mode: 'desktop',
      runId: manifest.runId,
      fileCount: files.length,
      bytes: manifest.totals.bytes,
      location,
      vaultFiles: vault.files,
      vaultBytes: vault.bytes,
      vaultError: vault.error,
    };
    rememberLast(result);
    return result;
  }

  const blob = await zipBackup(files);
  const name = `Stambha-backup-${manifest.runId}.zip`;
  downloadBlob(blob, name);
  const result: BackupResult = {
    mode: 'download',
    runId: manifest.runId,
    fileCount: files.length,
    bytes: manifest.totals.bytes,
    location: name,
  };
  rememberLast(result);
  return result;
}

export function lastBackup(): BackupResult | null {
  try {
    const raw = localStorage.getItem(LAST_BACKUP_KEY);
    return raw ? (JSON.parse(raw) as BackupResult) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export interface RestoreResult {
  runId: string;
  restored: number;
  skipped: number;
  cleared: number;
  missing: string[];
  ignoredKeys: string[];
  corrupt: string[];
  snapshot: boolean;
  createdAt: string;
  /** Files copied back into the vault by a desktop folder restore. */
  vaultRestored?: number;
  vaultSkipped?: number;
  vaultError?: string;
}

export interface RestoreOptions {
  /**
   * Replace the backed-up projects completely (default). `false` merges, which
   * is only useful for tests and for adding one job to an existing file.
   */
  replace?: boolean;
}

export interface RestoreSnapshotInfo {
  at: string;
  runId?: string;
  keys: number;
}

const PROJECT_ID_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;

export function isKnownRestorableKey(key: string): boolean {
  return RESTORABLE_KEYS.has(key);
}

/** Manifest markers this build reads: it writes "stambha", older builds wrote "contractorOS". */
const APP_MARKERS = new Set(['stambha', 'sthamba', 'contractorOS']);

function isAppMarker(value: unknown): boolean {
  return typeof value === 'string' && APP_MARKERS.has(value);
}

/** Reject anything that is not one of our manifests before touching storage. */
function assertManifest(manifest: BackupManifest): void {
  if (!manifest || !isAppMarker(manifest.app) || !Array.isArray(manifest.files)) {
    throw new Error('This file is not a Stambha backup — its manifest is missing or unreadable.');
  }
  const version = Number(manifest.version);
  if (!Number.isFinite(version) || version < MIN_BACKUP_FORMAT_VERSION) {
    throw new Error(`Unsupported backup format (v${String(manifest.version)}).`);
  }
  if (version > BACKUP_FORMAT_VERSION) {
    throw new Error(
      `This backup was written by a newer Stambha (format v${version}). Update the app before restoring it.`
    );
  }
  if (!manifest.runId || !manifest.createdAt) {
    throw new Error('This backup manifest is incomplete (no run id or date).');
  }
}

interface ScopeTarget {
  key: string;
  base: string;
  projectId?: string;
}

/** Every storage key a restore of this manifest is allowed to replace. */
function scopeTargets(projectIds: string[]): ScopeTarget[] {
  const targets: ScopeTarget[] = [];
  for (const projectId of projectIds) {
    for (const feature of PROJECT_FEATURES) {
      targets.push({ key: scopedKey(feature.base, projectId), base: feature.base, projectId });
    }
  }
  for (const feature of COMPANY_FEATURES) targets.push({ key: feature.base, base: feature.base });
  return targets;
}

interface RestorePlan {
  writes: { key: string; content: string; path: string }[];
  clears: string[];
  missing: string[];
  ignoredKeys: string[];
  corrupt: string[];
  skipped: number;
}

function planRestore(files: Record<string, string>, manifest: BackupManifest, replace: boolean): RestorePlan {
  const projectIds = new Set<string>();
  for (const project of manifest.projects || []) {
    const id = normalizeProjectId(project?.id || '');
    if (id) projectIds.add(id);
  }
  for (const entry of manifest.files) {
    if (!entry?.projectId) continue;
    const id = normalizeProjectId(entry.projectId);
    if (id) projectIds.add(id);
  }

  const writes: RestorePlan['writes'] = [];
  const writeKeys = new Set<string>();
  const missing: string[] = [];
  const ignoredKeys: string[] = [];
  const corrupt: string[] = [];
  let skipped = 0;

  for (const entry of manifest.files) {
    if (!entry || !entry.restorable || !entry.key) {
      skipped += 1;
      continue;
    }
    // Security: a manifest may only write business data, never credentials,
    // preferences or the app's own bookkeeping keys.
    if (!isKnownRestorableKey(entry.key)) {
      ignoredKeys.push(entry.key);
      skipped += 1;
      continue;
    }
    if (entry.projectId && !PROJECT_ID_PATTERN.test(normalizeProjectId(entry.projectId))) {
      corrupt.push(entry.path);
      skipped += 1;
      continue;
    }
    const path = String(entry.path || '').replace(/\\/g, '/');
    const content = files[path] ?? files[entry.path];
    if (typeof content !== 'string') {
      missing.push(path);
      skipped += 1;
      continue;
    }
    // A truncated or edited file must not be written silently.
    if (entry.checksum && checksumOf(content) !== entry.checksum) {
      corrupt.push(path);
      skipped += 1;
      continue;
    }
    if (!RAW_VALUE_KEYS.has(entry.key)) {
      try {
        JSON.parse(content);
      } catch {
        corrupt.push(path);
        skipped += 1;
        continue;
      }
    }
    // Older backups stored company/ledger settings once for the whole machine.
    // They now belong to a job, so restore them into the open job rather than
    // leaving them under a bare key that no project-scoped read can see.
    const targetKey = entry.projectId
      ? scopedKey(entry.key, entry.projectId)
      : PROJECT_SCOPED_BASES.has(entry.key)
        ? scopedKey(entry.key, getActiveProject())
        : entry.key;
    if (!writeKeys.has(targetKey)) writeKeys.add(targetKey);
    writes.push({ key: targetKey, content, path });
  }

  if (missing.length > 0) {
    const examples = missing.slice(0, 3).join(', ');
    throw new Error(
      `This backup is incomplete: ${missing.length} file(s) listed in its manifest are missing (${examples}). Nothing was changed.`
    );
  }
  if (corrupt.length > 0) {
    throw new Error(
      `This backup is damaged: ${corrupt.length} file(s) failed their checksum or could not be read (${corrupt
        .slice(0, 3)
        .join(', ')}). Nothing was changed.`
    );
  }

  const clears: string[] = [];
  if (replace) {
    for (const target of scopeTargets([...projectIds])) {
      if (writeKeys.has(target.key)) continue;
      // Exact restore: data that the backup does not contain is removed, so a
      // deleted job or cleared register does not come back from the dead.
      if (readRaw(target.key) !== null) clears.push(target.key);
      // Pre-migration data lives under the bare key for the scope owner and
      // would otherwise shadow the cleared scoped key.
      if (target.projectId === scopeOwner() && readRaw(target.base) !== null && !clears.includes(target.base)) {
        clears.push(target.base);
      }
    }
  }

  // Two manifest rows can name the same storage key (a re-run with a stale
  // manifest); the last one wins, exactly like writing them in order.
  const uniqueWrites = new Map<string, RestorePlan['writes'][number]>();
  for (const write of writes) uniqueWrites.set(write.key, write);

  return { writes: [...uniqueWrites.values()], clears, missing, ignoredKeys, corrupt, skipped };
}

function captureSnapshot(keys: string[], runId: string): { values: Record<string, string | null>; stored: boolean } {
  const values: Record<string, string | null> = {};
  for (const key of keys) values[key] = readRaw(key);
  try {
    localStorage.setItem(
      PRE_RESTORE_KEY,
      JSON.stringify({ at: new Date().toISOString(), runId, keys: keys.length, values })
    );
    return { values, stored: true };
  } catch {
    // Quota or blocked storage: the restore still proceeds, but undo is not
    // offered and the caller is told the safety copy was not kept.
    return { values, stored: false };
  }
}

function rollback(values: Record<string, string | null>): void {
  for (const [key, value] of Object.entries(values)) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* best effort — the error that triggered the rollback is already thrown */
    }
  }
}

function emitRestored() {
  if (typeof window === 'undefined') return;
  for (const name of [
    'contractoros:masters-changed',
    'contractoros:boq-changed',
    'contractoros:ledger-changed',
    'contractoros:project-changed',
    'contractoros:books-changed',
    'contractoros:stock-changed',
    'contractoros:commitments-changed',
  ]) {
    window.dispatchEvent(new CustomEvent(name));
  }
}

/** Restore from an in-memory file set (used by ZIP, desktop folder and tests). */
export function restoreFromFiles(
  files: Record<string, string>,
  manifest: BackupManifest,
  options: RestoreOptions = {}
): RestoreResult {
  assertManifest(manifest);

  // A backup carries one person's books. Restoring it into another account's
  // namespace would overwrite their work with a stranger's data.
  const current = activeBackupUser();
  if (manifest.user && !current) {
    throw new Error(
      `This backup belongs to @${manifest.user.username}. Sign in to that account before restoring it.`
    );
  }
  if (manifest.user && current && manifest.user.id !== current.id) {
    throw new Error(
      `This backup belongs to @${manifest.user.username}. Sign in as that account to restore it — it will not be written over @${current.username}.`
    );
  }

  const replace = options.replace !== false;
  const plan = planRestore(files, manifest, replace);
  if (plan.writes.length === 0) {
    throw new Error('This backup contains no restorable business data. Nothing was changed.');
  }

  const touched = [...new Set([...plan.writes.map((write) => write.key), ...plan.clears])];
  const snapshot = captureSnapshot(touched, manifest.runId);

  let restored = 0;
  let cleared = 0;
  try {
    for (const write of plan.writes) {
      localStorage.setItem(write.key, write.content);
      restored += 1;
    }
    for (const key of plan.clears) {
      localStorage.removeItem(key);
      cleared += 1;
    }
  } catch (error) {
    rollback(snapshot.values);
    throw new Error(
      `Restore stopped and was rolled back: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  emitRestored();
  return {
    runId: manifest.runId,
    restored,
    skipped: plan.skipped,
    cleared,
    missing: [],
    ignoredKeys: plan.ignoredKeys,
    corrupt: plan.corrupt,
    snapshot: snapshot.stored,
    createdAt: manifest.createdAt,
  };
}

/** The safety copy kept by the most recent restore, if it could be stored. */
export function pendingRestore(): RestoreSnapshotInfo | null {
  try {
    const raw = localStorage.getItem(PRE_RESTORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at?: string; runId?: string; values?: Record<string, string | null> };
    if (!parsed?.values) return null;
    return { at: String(parsed.at || ''), runId: parsed.runId, keys: Object.keys(parsed.values).length };
  } catch {
    return null;
  }
}

/** Put the data back exactly as it was before the last restore. */
export function undoLastRestore(): { reverted: number } {
  const raw = readRaw(PRE_RESTORE_KEY);
  if (!raw) throw new Error('There is no pre-restore copy to undo.');
  let values: Record<string, string | null>;
  try {
    const parsed = JSON.parse(raw) as { values?: Record<string, string | null> };
    if (!parsed?.values) throw new Error('empty');
    values = parsed.values;
  } catch {
    throw new Error('The pre-restore copy is unreadable, so it cannot be undone.');
  }
  let reverted = 0;
  for (const [key, value] of Object.entries(values)) {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    reverted += 1;
  }
  localStorage.removeItem(PRE_RESTORE_KEY);
  emitRestored();
  return { reverted };
}

function findManifestName(names: string[]): string | undefined {
  const latest = names.find((name) => /(^|\/)latest-manifest\.json$/.test(name));
  if (latest) return latest;
  return names
    .filter((name) => /(^|\/)manifest-\d{8}-\d{6}(-\d{3})?\.json$/.test(name))
    .sort()
    .pop();
}

export async function restoreFromZip(file: File | Blob, options: RestoreOptions = {}): Promise<RestoreResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new Error('That file is not a readable .zip archive.');
  }
  const manifestName = findManifestName(Object.keys(zip.files));
  if (!manifestName) {
    throw new Error('No Stambha manifest found in this zip. Pick a backup made by this app.');
  }
  const manifestFile = zip.file(manifestName);
  if (!manifestFile) throw new Error('The backup manifest could not be read from this zip.');
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(await manifestFile.async('string')) as BackupManifest;
  } catch {
    throw new Error('The backup manifest in this zip is not valid JSON.');
  }
  assertManifest(manifest);

  const contents: Record<string, string> = {};
  for (const entry of manifest.files || []) {
    const name = String(entry?.path || '').replace(/\\/g, '/');
    const file = zip.file(name);
    if (file) contents[name] = await file.async('string');
  }
  return restoreFromFiles(contents, manifest, options);
}

// ---------------------------------------------------------------------------
// Desktop folder backups
// ---------------------------------------------------------------------------

export interface LocalBackupRun {
  runId: string;
  createdAt: string;
  files: number;
  bytes: number;
}

function desktopUserFolder(): string | null {
  const user = activeBackupUser();
  return user ? sanitizeSegment(user.username, user.id) : null;
}

/** Runs found under Documents/Stambha for the signed-in account. */
export async function listLocalBackups(): Promise<LocalBackupRun[]> {
  if (!isDesktopApp()) return [];
  const { listBackupRunsNative } = await import('./desktop');
  const runs = await listBackupRunsNative(desktopUserFolder(), backupLocationForNative());
  return runs
    .map((run) => ({
      runId: String(run.runId || ''),
      createdAt: String(run.createdAt || ''),
      files: Number(run.files) || 0,
      bytes: Number(run.bytes) || 0,
    }))
    .filter((run) => run.runId)
    .sort((a, b) => (a.runId < b.runId ? 1 : -1));
}

/** Restore one saved folder backup from Documents/Stambha. */
export async function restoreDesktopRun(runId: string, options: RestoreOptions = {}): Promise<RestoreResult> {
  if (!isDesktopApp()) throw new Error('Restoring a folder backup is only available in the desktop app.');
  const { readBackupRunNative } = await import('./desktop');
  const bundle = await readBackupRunNative(runId, desktopUserFolder(), backupLocationForNative());
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(bundle.manifest) as BackupManifest;
  } catch {
    throw new Error('That backup manifest is not valid JSON.');
  }
  const files: Record<string, string> = {};
  for (const file of bundle.files) files[String(file.path).replace(/\\/g, '/')] = file.content;
  const restored = restoreFromFiles(files, manifest, options);
  const vault = await restoreVaultFromRun(String(bundle.folder || ''), manifest, runId);
  return {
    ...restored,
    vaultRestored: vault.restored,
    vaultSkipped: vault.skipped,
    vaultError: vault.error,
  };
}
