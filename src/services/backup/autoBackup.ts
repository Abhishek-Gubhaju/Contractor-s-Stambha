// ============================================================================
// Automatic safety backups.
//
// A force-quit, crash or power cut cannot run code at the moment it happens, so
// nothing can be backed up "after" it. What we can guarantee is that there is
// never much new work in memory only: while the app is open on the desktop it
// quietly writes a backup whenever the books changed, on a short timer and
// whenever the window loses focus. At worst a few minutes of typing is lost,
// never the whole day.
//
// Only the desktop build auto-writes to disk. In a browser an automatic backup
// would mean an unexpected ZIP download every few minutes, so the browser asks
// explicitly instead (sign-out dialog / close prompt).
// ============================================================================
import { checksumOf } from './backupService';
import { runBackup } from './backupService';
import { isDesktopApp } from './desktop';

export const AUTO_BACKUP_KEY = 'contractoros_auto_backup';

/** Bookkeeping keys that must not count as "the books changed". */
const IGNORED_PREFIXES = [
  'contractoros_auth',
  'contractoros_last_backup',
  'contractoros_pre_restore',
  'contractoros_auto_backup',
  'contractoros_backup_nudge',
];

/** A quiet backup at most this often, even if the window is blurred a lot. */
const MIN_GAP_MS = 60_000;
/** How often the timer checks for unsaved work. */
const TICK_MS = 60_000;
/** An interval backup is only written after this much new data. */
export const AUTO_BACKUP_MINUTES = 5;

export interface AutoBackupRecord {
  at: number;
  fingerprint: string;
  runId?: string;
}

function readable(key: string): boolean {
  return !IGNORED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Cheap fingerprint of everything the backup would capture (key + size).
 * Deliberately excludes credentials and the backup's own bookkeeping, so
 * signing in or writing a backup does not itself look like new work.
 */
export function dataFingerprint(): string {
  try {
    const parts: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !readable(key)) continue;
      const value = localStorage.getItem(key) || '';
      parts.push(`${key}:${value.length}`);
    }
    parts.sort();
    return checksumOf(parts.join('|'));
  } catch {
    return '';
  }
}

export function readAutoBackup(): AutoBackupRecord | null {
  try {
    const raw = localStorage.getItem(AUTO_BACKUP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AutoBackupRecord>;
    if (typeof parsed?.at !== 'number' || typeof parsed?.fingerprint !== 'string') return null;
    return { at: parsed.at, fingerprint: parsed.fingerprint, runId: parsed.runId };
  } catch {
    return null;
  }
}

function rememberAutoBackup(record: AutoBackupRecord) {
  try {
    localStorage.setItem(AUTO_BACKUP_KEY, JSON.stringify(record));
  } catch {
    /* storage blocked — the backup itself was already written */
  }
}

/** Should a silent backup run now? Pure so the rule is testable. */
export function backupIsDue(
  fingerprint: string,
  record: AutoBackupRecord | null,
  now: number,
  minGapMs = MIN_GAP_MS
): boolean {
  if (!fingerprint) return false;
  if (!record) return true;
  if (record.fingerprint === fingerprint) return false;
  return now - record.at >= minGapMs;
}

export interface AutoBackupOutcome {
  skipped: boolean;
  reason?: 'browser' | 'unchanged' | 'too-soon' | 'failed';
  runId?: string;
  fileCount?: number;
  error?: string;
}

/**
 * Write a backup only when there is something new. Never throws: this runs in
 * the background and must not be able to break a sign-out or a close.
 */
export async function autoBackup(now = Date.now()): Promise<AutoBackupOutcome> {
  if (!isDesktopApp()) return { skipped: true, reason: 'browser' };
  const fingerprint = dataFingerprint();
  if (!fingerprint) return { skipped: true, reason: 'unchanged' };
  const record = readAutoBackup();
  if (!backupIsDue(fingerprint, record, now)) {
    return { skipped: true, reason: record?.fingerprint === fingerprint ? 'unchanged' : 'too-soon' };
  }
  try {
    const result = await runBackup();
    if (result.mode === 'desktop') {
      rememberAutoBackup({ at: now, fingerprint, runId: result.runId });
    }
    return { skipped: false, runId: result.runId, fileCount: result.fileCount };
  } catch (error) {
    return { skipped: true, reason: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Keep a fresh backup while the app is open: every minute check for new work,
 * and also check when the window loses focus (the moment before a quit/lock).
 */
export function startAutoBackupWatcher(): () => void {
  if (!isDesktopApp()) return () => {};
  let stopped = false;

  const quietly = () => {
    if (stopped) return;
    void autoBackup();
  };

  const timer = window.setInterval(quietly, TICK_MS);
  const onBlur = () => quietly();
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') quietly();
  };
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibility);

  // A first pass shortly after opening catches work left from a crash.
  const kickoff = window.setTimeout(quietly, 20_000);

  return () => {
    stopped = true;
    window.clearInterval(timer);
    window.clearTimeout(kickoff);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
