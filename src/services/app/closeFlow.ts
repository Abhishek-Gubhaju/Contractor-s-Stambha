// ============================================================================
// Closing the desktop window (or quitting) is a checkpoint, not an instant
// exit: the window asks whether to back up first. The native side prevents the
// close, this dialog decides, and only then does the app actually exit.
// ============================================================================
import { confirmDialog, choiceDialog, notify } from '../../components/ui/DialogHost';
import { runBackup } from '../backup/backupService';
import { isDesktopApp, markClosePromptReady, quitApp } from '../backup/desktop';
import { flushMirror } from '../storage/mirror';

let asking = false;

async function closeNow(): Promise<void> {
  try {
    await quitApp();
  } catch {
    // The native command is the only way out; if it is unavailable (e.g. a
    // plain browser tab) the tab close the person asked for already happened.
  }
}

/**
 * Ask once whether to back up, then close. Re-entrant calls (a second Cmd+Q
 * while the dialog is open) are ignored instead of stacking dialogs.
 */
export async function requestAppClose(): Promise<boolean> {
  if (asking) return false;
  asking = true;
  try {
    const choice = await choiceDialog({
      title: 'Back up before closing?',
      message:
        'Keep a dated copy of every job, the ledger and the company records before the app closes. The app also saves quietly while it is open, so this is the last checkpoint of the session.',
      options: [
        { value: 'backup', label: 'Back up, then close', tone: 'primary' },
        { value: 'without-backup', label: 'Close without a backup', tone: 'neutral' },
      ],
      cancelLabel: 'Keep working',
    });

    if (!choice) return false;
    if (choice === 'without-backup') {
      try {
        await flushMirror();
      } catch {
        /* the close must still go through */
      }
      await closeNow();
      return true;
    }

    try {
      const result = await runBackup();
      notify(`Backup written: ${result.fileCount} files`);
      await closeNow();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const leave = await confirmDialog({
        title: 'Backup failed',
        message: `The backup could not be written:\n\n${message}\n\nClose anyway? Your data stays on this computer; only the separate backup copy was not made.`,
        confirmLabel: 'Close anyway',
        cancelLabel: 'Keep working',
      });
      if (!leave) return false;
      await closeNow();
      return true;
    }
  } finally {
    asking = false;
  }
}

/** Listen for the native close request. Returns the unsubscribe function. */
export async function watchCloseRequests(): Promise<() => void> {
  if (!isDesktopApp()) return () => {};
  try {
    // From here on the native shell diverts closes to this dialog. If the UI
    // never gets this far, closes keep working the normal way.
    await markClosePromptReady();
    const { listen } = await import('@tauri-apps/api/event');
    return await listen('app:close-requested', () => {
      void requestAppClose();
    });
  } catch {
    // Older native shell without the event: the window still closes normally.
    return () => {};
  }
}
