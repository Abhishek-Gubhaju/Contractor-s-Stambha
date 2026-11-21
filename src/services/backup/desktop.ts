// Desktop bridge (Tauri). In the packaged app these commands write real files
// under ~/Documents/Stambha with no permission prompt. In a browser the
// detection is false and callers fall back to a ZIP download.

interface TauriWindow {
  __TAURI_INTERNALS__?: { invoke?: unknown };
}

export function isDesktopApp(): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as TauriWindow).__TAURI_INTERNALS__);
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const mod = await import('@tauri-apps/api/core');
  return mod.invoke<T>(command, args);
}

export interface NativeFile {
  path: string;
  content: string;
}

/**
 * Write the whole backup tree; resolves to the root folder that was written.
 * `root` is the person's chosen folder (null/undefined = Documents default).
 */
export async function saveBackupFilesNative(files: NativeFile[], root?: string | null): Promise<string> {
  return invoke<string>('save_backup_files', { files, root: root || null });
}

/**
 * Open the native print panel for this window.
 *
 * The desktop webview's own window.print() is a no-op on some macOS builds, so
 * the app asks Tauri to run the webview print operation directly. That native
 * operation exists on macOS only: elsewhere the command answers false and the
 * caller prints through the webview's own dialog instead.
 */
export async function printWindowNative(): Promise<boolean> {
  return invoke<boolean>('print_window');
}

/** Ask for a folder with the native picker; null when the panel is dismissed. */
export async function chooseBackupFolderNative(start?: string | null): Promise<string | null> {
  return invoke<string | null>('choose_backup_folder', { start: start || null });
}

/** Reveal the backup folder in Finder/Explorer. */
export async function revealBackupFolder(root?: string | null): Promise<void> {
  await invoke<void>('reveal_backup_folder', { root: root || null });
}

export interface NativeBackupRun {
  runId: string;
  createdAt: string;
  files: number;
  bytes: number;
}

export interface NativeBackupBundle {
  manifest: string;
  files: NativeFile[];
  /** The run's own folder, where its Vault/ copy sits. */
  folder: string;
}

/** Backup runs under the chosen folder (or Documents/Stambha), one account. */
export async function listBackupRunsNative(user: string | null, root?: string | null): Promise<NativeBackupRun[]> {
  return invoke<NativeBackupRun[]>('list_backup_runs', { user, root: root || null });
}

/** One saved run: its manifest plus every file the manifest lists. */
export async function readBackupRunNative(runId: string, user: string | null, root?: string | null): Promise<NativeBackupBundle> {
  return invoke<NativeBackupBundle>('read_backup_run', { runId, user, root: root || null });
}

/** Exit the app after the close prompt has been answered. */
export async function quitApp(): Promise<void> {
  try {
    await invoke<void>('quit_app');
  } catch {
    // Native shell too old for the command: close the window the plain way.
    window.close();
  }
}

/** Tell the native shell the close prompt is ready to take close requests. */
export async function markClosePromptReady(): Promise<void> {
  await invoke<void>('close_prompt_ready');
}

export interface NativeMirrorMeta {
  saved_at: string;
  bytes: number;
  keys: number;
  username: string | null;
}

export interface NativeMirrorStatus {
  current: NativeMirrorMeta | null;
  previous: NativeMirrorMeta | null;
  folder: string;
}

/** Write the durable mirror for one account (atomic, keeps one previous copy). */
export async function writeMirrorNative(user: string, payload: string): Promise<NativeMirrorMeta> {
  return invoke<NativeMirrorMeta>('mirror_write', { user, payload });
}

export async function mirrorStatusNative(user: string): Promise<NativeMirrorStatus> {
  return invoke<NativeMirrorStatus>('mirror_status', { user });
}

export async function readMirrorNative(user: string, which: 'current' | 'previous'): Promise<string> {
  return invoke<string>('mirror_read', { user, which });
}
