// ============================================================================
// SecurityCard — the account side of Settings: your password, your passcode,
// and (for an administrator) the other accounts on this computer.
//
// Nothing here ever displays or stores a secret: the service only keeps hashes,
// and these forms hand the plaintext straight to it and clear it.
// ============================================================================
import { useState } from 'react';
import { KeyRound, Lock, LogOut, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { notify } from '../../components/ui/DialogHost';
import { confirmDialog, destroyDialog } from '../../components/ui/DialogHost';
import { purgeVaultForUser } from '../../services/vault/vaultService';
import {
  PASSCODE_LENGTH,
  changeOwnPassword,
  createUser,
  loadAuthLog,
  lockSession,
  passwordProblems,
  passcodeProblem,
  publicUsers,
  removeUser,
  setPasscode,
  setPassword,
  unlockUser,
} from '../../services/auth/authService';
import { requestSignOut } from '../../services/auth/signOutFlow';
import { useAuth } from '../../services/auth/useAuth';
import { RecoveryCard } from './RecoveryCard';

const input = 'w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm text-gray-900 bg-white';

export function SecurityCard() {
  const auth = useAuth();
  const me = auth.user;
  const [users, setUsers] = useState(() => publicUsers());
  const [busy, setBusy] = useState(false);

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmPw, setConfirmPw] = useState('');

  const [pin, setPin] = useState('');

  const [newUser, setNewUser] = useState({ username: '', displayName: '', password: '', admin: false });
  const [resetFor, setResetFor] = useState<{ id: string; password: string } | null>(null);

  const refresh = () => setUsers(publicUsers());
  const fail = (e: unknown) => notify(e instanceof Error ? e.message : String(e), 'error');

  if (!me) {
    return (
      <div className="bg-white rounded-xl border p-6">
        <h2 className="text-lg font-bold mb-1">Users &amp; security</h2>
        <p className="text-xs text-gray-500">Sign in to manage accounts.</p>
      </div>
    );
  }

  const submitPassword = async () => {
    if (busy) return;
    if (next !== confirmPw) return notify('The two new passwords do not match.', 'error');
    const problems = passwordProblems(next, me.username);
    if (problems.length) return notify(problems[0], 'error');
    setBusy(true);
    try {
      await changeOwnPassword(me.id, current, next);
      setCurrent('');
      setNext('');
      setConfirmPw('');
      notify('Password changed.');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const submitPasscode = async () => {
    if (busy) return;
    const issue = passcodeProblem(pin);
    if (issue) return notify(issue, 'error');
    setBusy(true);
    try {
      await setPasscode(me.id, pin);
      setPin('');
      refresh();
      notify(`Passcode set — ${PASSCODE_LENGTH} digits for quick unlock.`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const clearPasscode = async () => {
    setBusy(true);
    try {
      await setPasscode(me.id, null);
      refresh();
      notify('Passcode removed. The password is required to unlock.');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const addUser = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await createUser(newUser);
      setNewUser({ username: '', displayName: '', password: '', admin: false });
      refresh();
      notify('User created.');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const doReset = async () => {
    if (!resetFor) return;
    setBusy(true);
    try {
      await setPassword(resetFor.id, resetFor.password, me.id);
      setResetFor(null);
      refresh();
      notify('Password reset.');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const removeAccount = async (user: { id: string; username: string; displayName: string }) => {
    if (!me) return;
    const ok = await destroyDialog({
      title: 'Remove user',
      message: `Remove the account "${user.displayName}" (${user.username})?\n\nThey will no longer be able to sign in on this computer.`, 
      confirmLabel: 'Remove account',
    });
    if (!ok) return;
    quiet(() => removeUser(user.id, me.id));
    // The account's vault files are as personal as its books; remove them on
    // this computer too. Best-effort: a failed cleanup must not resurrect the
    // account or make the UI claim it is still there.
    void purgeVaultForUser(user.id);
  };

  const quiet = (fn: () => void) => {
    try {
      fn();
      refresh();
    } catch (e) {
      fail(e);
    }
  };

  const log = loadAuthLog().slice(0, 6);

  return (
    <>
    <div className="bg-white rounded-xl border p-6" data-testid="security-card">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold mb-1">Users &amp; security</h2>
          <p className="text-xs text-gray-500">
            Signed in as <span className="font-medium text-gray-700">{me.displayName}</span> (@{me.username})
            {me.admin ? ' · administrator' : ''}
          </p>
          <p className="mt-1 text-[11px] text-gray-500">
            Each account has its own jobs, ledger, billing and settings on this computer.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => lockSession()}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-lg px-3 py-1.5"
          >
            <Lock className="w-4 h-4" /> Lock now
          </button>
          <button
            type="button"
            onClick={() => { void requestSignOut(); }}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-rose-700 bg-white border border-rose-200 hover:bg-rose-50 rounded-lg px-3 py-1.5"
          >
            <LogOut className="w-4 h-4" /> Sign out
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-5">
        <div>
          <h3 className="text-sm font-semibold text-gray-800 mb-2 flex items-center gap-1.5">
            <KeyRound className="w-4 h-4 text-gray-500" /> Change password
          </h3>
          <div className="space-y-2">
            <input className={input} type="password" placeholder="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" aria-label="Current password" />
            <input className={input} type="password" placeholder="New password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" aria-label="New password" />
            <input className={input} type="password" placeholder="Confirm new password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" aria-label="Confirm new password" />
            <button
              type="button"
              onClick={submitPassword}
              disabled={busy || !current || !next}
              className="text-sm font-medium text-white bg-gray-900 hover:bg-gray-800 disabled:opacity-50 rounded-lg px-3 py-1.5"
            >
              Update password
            </button>
          </div>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-gray-800 mb-2 flex items-center gap-1.5">
            <ShieldCheck className="w-4 h-4 text-gray-500" /> Passcode
          </h3>
          <p className="text-[11px] text-gray-500 mb-2">
            A {PASSCODE_LENGTH}-digit passcode unlocks a locked screen. It never replaces the password, and five wrong tries make it wait.
          </p>
          <div className="flex gap-2">
            <input
              className={`${input} tracking-[0.3em] font-mono`}
              inputMode="numeric"
              maxLength={PASSCODE_LENGTH}
              placeholder="••••••"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, PASSCODE_LENGTH))}
              aria-label="New passcode"
            />
            <button
              type="button"
              onClick={submitPasscode}
              disabled={busy || pin.length !== PASSCODE_LENGTH}
              className="whitespace-nowrap text-sm font-medium text-white bg-gray-900 hover:bg-gray-800 disabled:opacity-50 rounded-lg px-3 py-1.5"
            >
              Set
            </button>
            <button
              type="button"
              onClick={clearPasscode}
              disabled={busy || !users.find((u) => u.id === me.id)?.hasPasscode}
              className="whitespace-nowrap text-sm font-medium text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-50 rounded-lg px-3 py-1.5"
            >
              Remove
            </button>
          </div>
        </div>
      </div>

      <div className="mt-6 border-t pt-4">
        <h3 className="text-sm font-semibold text-gray-800 mb-2">Accounts on this computer</h3>
        <div className="space-y-1.5">
          {users.map((u) => (
            <div key={u.id} className="flex items-center justify-between gap-2 text-sm border border-gray-100 rounded-lg px-3 py-1.5">
              <div className="min-w-0">
                <p className="font-medium text-gray-900 truncate">
                  {u.displayName} <span className="text-gray-400 font-normal">@{u.username}</span>
                  {u.admin && <span className="ml-1.5 text-[10px] uppercase tracking-wide text-blue-700 bg-blue-50 rounded px-1 py-0.5">admin</span>}
                </p>
                <p className="text-[11px] text-gray-500">
                  {u.lastLoginAt ? `last signed in ${new Date(u.lastLoginAt).toLocaleString()}` : 'never signed in'}
                  {u.locked ? ' · locked (too many attempts)' : ''}
                  {u.hasPasscode ? ' · passcode' : ''}
                  {u.hasRecovery ? ' · recovery set' : ' · no recovery'}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {resetFor?.id === u.id ? (
                  <>
                    <input
                      className="border border-gray-300 rounded px-2 py-1 text-xs w-40"
                      type="password"
                      placeholder="New password"
                      value={resetFor.password}
                      onChange={(e) => setResetFor({ id: u.id, password: e.target.value })}
                      aria-label="Reset password"
                    />
                    <button type="button" onClick={doReset} disabled={busy || !resetFor.password} className="text-xs text-blue-700 hover:underline disabled:opacity-50">
                      Save
                    </button>
                    <button type="button" onClick={() => setResetFor(null)} className="text-xs text-gray-500 hover:underline">
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    {me.admin && u.id !== me.id && (
                      <button type="button" onClick={() => setResetFor({ id: u.id, password: '' })} className="text-xs text-gray-600 hover:underline">
                        Reset
                      </button>
                    )}
                    {me.admin && u.locked && (
                      <button type="button" onClick={() => quiet(() => unlockUser(u.id, me.id))} className="text-xs text-amber-700 hover:underline">
                        Unlock
                      </button>
                    )}
                    {me.admin && u.id !== me.id && (
                      <button
                        type="button"
                        onClick={() => void removeAccount(u)}
                        className="text-gray-400 hover:text-rose-600"
                        aria-label={`Remove ${u.username}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        {me.admin && (
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-4 gap-2 items-end">
            <input className={input} placeholder="username" value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} aria-label="New username" />
            <input className={input} placeholder="Full name" value={newUser.displayName} onChange={(e) => setNewUser({ ...newUser, displayName: e.target.value })} aria-label="New user name" />
            <input className={input} type="password" placeholder="Password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} aria-label="New user password" autoComplete="new-password" />
            <button
              type="button"
              onClick={addUser}
              disabled={busy || !newUser.username || !newUser.password}
              className="inline-flex items-center justify-center gap-1.5 text-sm font-medium text-white bg-gray-900 hover:bg-gray-800 disabled:opacity-50 rounded-lg px-3 py-1.5"
            >
              <UserPlus className="w-4 h-4" /> Add
            </button>
            <label className="sm:col-span-4 flex items-center gap-2 text-[11px] text-gray-600">
              <input type="checkbox" checked={newUser.admin} onChange={(e) => setNewUser({ ...newUser, admin: e.target.checked })} />
              Administrator (can manage accounts and reset passwords)
            </label>
          </div>
        )}
      </div>

      {log.length > 0 && (
        <div className="mt-5 border-t pt-3">
          <h3 className="text-xs font-semibold text-gray-700 mb-1.5">Recent sign-in activity</h3>
          <ul className="space-y-0.5">
            {log.map((entry, i) => (
              <li key={`${entry.at}-${i}`} className="text-[11px] text-gray-500">
                <span className="tabular-nums">{new Date(entry.at).toLocaleString()}</span> · {entry.type} · @{entry.username}
                {entry.detail ? ` · ${entry.detail}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
    <RecoveryCard userId={me.id} username={me.username} />
    </>
  );
}
