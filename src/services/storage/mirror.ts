// ============================================================================
// Durable native mirror of the live books.
//
// localStorage is fast but it is one hidden copy. After every save, the app now
// writes the same business data as a real file under the app's data folder:
//
//   ~/Library/Application Support/com.contractoros.app/mirror/<account>/live.json
//
// The write is atomic (temp file → fsync → rename) and the previous version is
// rotated to live.previous.json, so a crash mid-write can never leave a torn
// file and a bad edit can always step back one version. Restoring a mirror goes
// through the same validated restore path as a backup (whitelist, checksums,
// pre-restore snapshot, undo), so a mirror file is never trusted blindly.
// ============================================================================
import { activeUser } from '../auth/authService';
import { setStorageWriteListener } from './userStorage';
import { isDesktopApp, mirrorStatusNative, readMirrorNative, writeMirrorNative } from '../backup/desktop';
import { BACKUP_FORMAT_VERSION, RESTORABLE_KEYS, checksumOf, restoreFromFiles, type BackupManifest, type RestoreResult } from '../backup/backupService';

const MIRROR_KIND = 'live-mirror';
const MIRROR_VERSION = 1;
/** Fired after a native mirror write lands, so any open screen can refresh. */
export const MIRROR_UPDATED_EVENT = 'contractoros:mirror-updated';
/** Debounce: several saves in a row produce one file write. */
const DEBOUNCE_MS = 1500;

export interface MirrorMeta {
  savedAt: string;
  bytes: number;
  keys: number;
  username: string | null;
}

export interface MirrorStatus {
  current: MirrorMeta | null;
  previous: MirrorMeta | null;
  folder: string;
}

export interface MirrorPayload {
  /** Written by this build; the other values come from earlier builds. */
  app: 'stambha' | 'sthamba' | 'contractorOS';
  kind: typeof MIRROR_KIND;
  version: number;
  savedAt: string;
  user: { id: string; username: string; displayName: string };
  keys: Record<string, string>;
  /** Fingerprint of the key map, so a hand-edited mirror is refused. */
  checksum: string;
}

let lastFingerprint = '';
let timer: number | undefined;
/** Set by any save; a blur/hide flush can skip all serialisation when clean. */
let dirty = true;
/** Bumped by every save, so a write that lands late cannot mark a newer save clean. */
let revision = 0;

/** Business keys the mirror is allowed to hold (same set restore accepts). */
export function isMirroredKey(key: string): boolean {
  if (!key || !key.startsWith('contractoros_')) return false;
  return RESTORABLE_KEYS.has(key.split('::')[0]);
}

/** Everything a restore would need, read exactly as the app sees it. */
export function collectMirrorKeys(): Record<string, string> {
  const keys: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !isMirroredKey(key)) continue;
      const value = localStorage.getItem(key);
      if (value !== null) keys[key] = value;
    }
  } catch {
    /* storage blocked — the mirror simply reuses the last good file */
  }
  return keys;
}

export function buildMirrorPayload(): MirrorPayload | null {
  const user = activeUser();
  if (!user) return null;
  const keys = collectMirrorKeys();
  return {
    app: 'stambha',
    kind: MIRROR_KIND,
    version: MIRROR_VERSION,
    savedAt: new Date().toISOString(),
    user: { id: user.id, username: user.username, displayName: user.displayName },
    keys,
    checksum: checksumOf(JSON.stringify(keys)),
  };
}

export interface PushOutcome {
  skipped: boolean;
  reason?: 'browser' | 'signed-out' | 'empty' | 'unchanged' | 'failed';
  error?: string;
}

/** Write the current books to the native mirror, unless nothing changed. */
export async function pushMirrorNow(): Promise<PushOutcome> {
  if (!isDesktopApp()) return { skipped: true, reason: 'browser' };
  const payload = buildMirrorPayload();
  if (!payload) return { skipped: true, reason: 'signed-out' };
  if (Object.keys(payload.keys).length === 0) return { skipped: true, reason: 'empty' };

  const serialized = JSON.stringify(payload);
  // The account is part of the fingerprint: two accounts can hold identical
  // data (or both be empty), and the second must still get its own mirror file
  // instead of inheriting "nothing changed" from the first.
  const fingerprint = `${payload.user.id}:${payload.checksum}`;
  if (fingerprint === lastFingerprint) return { skipped: true, reason: 'unchanged' };

  try {
    const writtenAt = revision;
    await writeMirrorNative(payload.user.id, serialized);
    lastFingerprint = fingerprint;
    if (writtenAt === revision) dirty = false;
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(MIRROR_UPDATED_EVENT));
    return { skipped: false };
  } catch (error) {
    return { skipped: true, reason: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

/** Coalesce bursts of saves into a single mirror write. */
export function scheduleMirrorPush(delay = DEBOUNCE_MS): void {
  if (!isDesktopApp()) return;
  if (typeof window === 'undefined') return;
  revision += 1;
  dirty = true;
  if (timer !== undefined) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = undefined;
    void flushMirror();
  }, delay);
}

/** Write right now (used on blur/hide and before a restore). */
export async function flushMirror(): Promise<PushOutcome> {
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timer = undefined;
  }
  if (!dirty) return { skipped: true, reason: 'unchanged' };
  return pushMirrorNow();
}

export async function mirrorStatus(): Promise<MirrorStatus | null> {
  if (!isDesktopApp()) return null;
  const user = activeUser();
  if (!user) return null;
  try {
    const status = await mirrorStatusNative(user.id);
    const map = (meta: typeof status.current): MirrorMeta | null =>
      meta
        ? { savedAt: String(meta.saved_at || ''), bytes: Number(meta.bytes) || 0, keys: Number(meta.keys) || 0, username: meta.username ?? null }
        : null;
    return { current: map(status.current), previous: map(status.previous), folder: String(status.folder || '') };
  } catch {
    return null;
  }
}

/** Mirror markers this build reads: it writes "stambha", older builds wrote "contractorOS". */
const MIRROR_APP_MARKERS = new Set(['stambha', 'sthamba', 'contractorOS']);

const isMirrorApp = (value: unknown): boolean =>
  typeof value === 'string' && MIRROR_APP_MARKERS.has(value);

function parseMirror(raw: string, userId: string, username: string): MirrorPayload {
  let payload: MirrorPayload;
  try {
    payload = JSON.parse(raw) as MirrorPayload;
  } catch {
    throw new Error('That mirror copy is not valid JSON.');
  }
  if (!isMirrorApp(payload?.app) || payload?.kind !== MIRROR_KIND) {
    throw new Error('That file is not a Stambha live mirror.');
  }
  const version = Number(payload.version);
  if (!Number.isFinite(version)) {
    throw new Error('That mirror copy has no format version, so it cannot be restored.');
  }
  if (version > MIRROR_VERSION) {
    throw new Error('This mirror was written by a newer Stambha. Update the app before restoring it.');
  }
  if (!payload.user || (payload.user.id !== userId && payload.user.username !== username)) {
    throw new Error('That mirror belongs to another account. Sign in as its owner to restore it.');
  }
  if (!payload.keys || typeof payload.keys !== 'object' || Array.isArray(payload.keys)) {
    throw new Error('That mirror copy has no data in it.');
  }
  if (!payload.checksum || payload.checksum !== checksumOf(JSON.stringify(payload.keys))) {
    throw new Error('That mirror copy is damaged (its checksum does not match). Nothing was changed.');
  }
  return payload;
}

/**
 * Restore the mirrored copy through the same validation as a backup:
 * whitelisted keys only, checksums checked, safety copy kept, undo available.
 */
export async function restoreFromMirror(which: 'current' | 'previous'): Promise<RestoreResult> {
  if (!isDesktopApp()) throw new Error('The durable mirror is only available in the desktop app.');
  const user = activeUser();
  if (!user) throw new Error('Sign in before restoring the mirrored copy.');

  const raw = await readMirrorNative(user.id, which);
  const payload = parseMirror(raw, user.id, user.username);

  const entries = Object.entries(payload.keys).filter(([, value]) => typeof value === 'string');
  if (entries.length === 0) throw new Error('That mirror copy contains no restorable data. Nothing was changed.');

  const files: Record<string, string> = {};
  const projectIds = new Set<string>();
  const manifestFiles: BackupManifest['files'] = entries.map(([logicalKey, content]) => {
    const [base, projectId] = logicalKey.split('::');
    if (projectId) projectIds.add(projectId);
    const path = `mirror/${logicalKey.replace(/[\\/]/g, '-')}.json`;
    files[path] = content;
    return {
      path,
      key: base,
      projectId,
      restorable: true,
      bytes: content.length,
      count: 0,
      checksum: checksumOf(content),
    };
  });

  const manifest: BackupManifest = {
    app: 'stambha',
    version: BACKUP_FORMAT_VERSION,
    runId: `mirror-${which}-${Date.now().toString(36)}`,
    createdAt: payload.savedAt || new Date().toISOString(),
    user: payload.user,
    projects: [...projectIds].map((id) => ({ id, name: id, folder: id })),
    files: manifestFiles,
    totals: {
      files: manifestFiles.length,
      bytes: manifestFiles.reduce((sum, entry) => sum + entry.bytes, 0),
    },
  };

  // Merge, not replace: the mirror holds the keys that existed at save time;
  // anything the app added later (a new module) must not be swept away.
  return restoreFromFiles(files, manifest, { replace: false });
}

/**
 * Start mirroring: every save is picked up at the storage boundary, bursts are
 * coalesced, and a flush runs when the window loses focus.
 */
export function startMirrorSync(): () => void {
  if (!isDesktopApp()) return () => {};

  setStorageWriteListener((key) => {
    // '' means clear(): assume the worst and take a write.
    if (!key || isMirroredKey(key)) scheduleMirrorPush();
  });

  const onLeave = () => {
    void flushMirror();
  };
  window.addEventListener('blur', onLeave);
  document.addEventListener('visibilitychange', onLeave);

  // First pass immediately: repairs a mirror left behind by a crash.
  void flushMirror();

  return () => {
    if (timer !== undefined) window.clearTimeout(timer);
    window.removeEventListener('blur', onLeave);
    document.removeEventListener('visibilitychange', onLeave);
    setStorageWriteListener(null);
  };
}
