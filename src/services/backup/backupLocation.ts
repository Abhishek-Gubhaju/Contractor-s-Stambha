// Where backups go.
//
// Default: ~/Documents/Stambha (the desktop shell resolves "Documents";
// the browser always downloads a ZIP). The desktop app can be pointed at any
// absolute folder — an external drive, a synced folder, a NAS mount — and the
// choice is remembered on this computer.
//
// The setting is a plain path string. Validation lives here so the Settings
// form and the desktop bridge agree, and so a bad value can never reach the
// filesystem command.
export const BACKUP_LOCATION_KEY = 'contractoros_backup_location';
export const DEFAULT_BACKUP_LOCATION_LABEL = 'Documents/Stambha';

/** The chosen folder, or null when the default is in use. */
export function loadBackupLocation(): string | null {
  try {
    const raw = localStorage.getItem(BACKUP_LOCATION_KEY);
    const value = raw ? raw.trim() : '';
    return value || null;
  } catch {
    return null;
  }
}

/** Remember the folder; an empty value clears it and restores the default. */
export function saveBackupLocation(path: string | null): void {
  try {
    const value = String(path || '').trim();
    if (!value) localStorage.removeItem(BACKUP_LOCATION_KEY);
    else localStorage.setItem(BACKUP_LOCATION_KEY, value);
  } catch {
    throw new Error('Could not save the backup folder — local storage is full or unavailable.');
  }
}

/**
 * Why a typed path cannot be used, or null when it is acceptable.
 * An empty string is fine — it means "go back to the default".
 */
export function backupLocationProblem(path: string): string | null {
  const value = String(path || '').trim();
  if (!value) return null;
  if (value.includes('\0')) return 'That folder path is not valid.';
  if (value.split(/[\\/]/).includes('..')) return 'The path cannot contain "..".';

  const windowsDrive = /^[a-zA-Z]:[\\/]/.test(value);
  const unc = value.startsWith('\\\\');
  const unix = value.startsWith('/');
  const home = value === '~' || value.startsWith('~/');
  if (!windowsDrive && !unc && !unix && !home) {
    return 'Enter an absolute folder path, for example /Users/you/Backups or ~/Backups.';
  }
  return null;
}

/** What to show the person: their folder, or the default. */
export function backupLocationLabel(path: string | null = loadBackupLocation()): string {
  return path || DEFAULT_BACKUP_LOCATION_LABEL;
}

/** The path handed to the native shell (null = Documents default). */
export function backupLocationForNative(): string | null {
  return loadBackupLocation();
}
