// ============================================================================
// Leaving safely.
//
// Every explicit sign-out goes through one dialog: back up first, leave without
// a backup, or stay signed in. Idle expiry cannot ask (nobody is at the
// keyboard), so it takes a silent backup when one is due and then ends the
// session.
// ============================================================================
import { confirmDialog, choiceDialog, notify } from '../../components/ui/DialogHost';
import { autoBackup } from '../backup/autoBackup';
import { runBackup } from '../backup/backupService';
import { flushMirror } from '../storage/mirror';
import { signOut } from './authService';

export type SignOutChoice = 'backup' | 'without-backup' | 'cancel';

/**
 * Ask what to do before signing out, then do it.
 * Returns true when the session actually ended.
 */
export async function requestSignOut(): Promise<boolean> {
  const choice = await choiceDialog({
    title: 'Back up before signing out?',
    message:
      'Your books are saved on this computer. A backup keeps a separate dated copy of every job, the ledger and the company records — useful before switching accounts or shutting down.',
    options: [
      { value: 'backup', label: 'Back up, then sign out', tone: 'primary' },
      { value: 'without-backup', label: 'Sign out without a backup', tone: 'neutral' },
    ],
    cancelLabel: 'Stay signed in',
  });

  if (!choice || choice === 'cancel') return false;

  // The durable mirror is the last safety copy; make sure it holds this save
  // before the storage namespace is torn down. Best effort, never blocking.
  try {
    await flushMirror();
  } catch {
    /* mirror failures must not trap someone in a session */
  }

  if (choice === 'without-backup') {
    signOut('manual');
    return true;
  }

  try {
    const result = await runBackup();
    notify(`Backup written: ${result.fileCount} files`);
    signOut('manual');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const leave = await confirmDialog({
      title: 'Backup failed',
      message: `The backup could not be written:\n\n${message}\n\nSign out anyway? Your data stays on this computer; only the separate backup copy was not made.`,
      confirmLabel: 'Sign out anyway',
      cancelLabel: 'Stay signed in',
    });
    if (!leave) return false;
    signOut('manual');
    return true;
  }
}

/**
 * The session expired on its own. Take a last silent backup (desktop only, and
 * only when something changed), then end the session without a dialog.
 */
export async function expireSession(): Promise<void> {
  try {
    await autoBackup();
  } catch {
    /* a failed safety backup must never keep an expired session alive */
  }
  signOut('expired');
}
