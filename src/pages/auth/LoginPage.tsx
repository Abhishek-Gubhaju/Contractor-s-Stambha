// ============================================================================
// LoginPage — setup, sign-in, lock, create-account and recovery in one place.
//
//   setup   → first administrator (with recovery), then straight in
//   login   → password sign-in, or the remembered account's passcode
//   locked  → passcode pad for a session that is locked but not ended
//   create  → another person's account: separate data, separate backup folder
//   recover → forgotten password, proved by two answers or the recovery key
//
// Security details that matter in the UI:
//   • a failed sign-in says "Invalid username or password" for both a wrong name
//     and a wrong password, so the screen cannot be used to discover accounts
//   • an explicit sign-out always asks for the PASSWORD next; the six-digit
//     passcode is a deliberate, visible choice from that screen
//   • a locked account shows a countdown instead of inviting more guesses
//   • the password field is cleared after a failed attempt; nothing is prefilled
//     after success
//   • every secret is handed to the service as plaintext and never kept
// ============================================================================
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Delete, LifeBuoy, Lock, User, UserPlus } from 'lucide-react';
import appIcon from '../../assets/app-icon.svg';
import { cn } from '../../utils';
import {
  PASSCODE_LENGTH,
  authenticate,
  authenticateWithPasscode,
  signedOutAt,
  startSession,
  unlockSession,
  type AuthUser,
} from '../../services/auth/authService';
import { Field, PasswordField, ProblemText, inputClass, primaryButton } from './authFields';
import { CreateAccountView } from './CreateAccountView';
import { RecoveryKeyPanel } from './RecoveryKeyPanel';
import { RecoveryView } from './RecoveryView';

interface RememberedAccount {
  id: string;
  username: string;
  name: string;
  hasPasscode: boolean;
}

interface LoginPageProps {
  mode: 'setup' | 'login' | 'locked';
  signedInName?: string;
  notice?: string;
  remembered?: RememberedAccount | null;
  onAuthenticated: () => void;
}

type View = 'signin' | 'create' | 'recover';

export default function LoginPage({ mode, signedInName, notice, remembered, onAuthenticated }: LoginPageProps) {
  const signedOut = Boolean(signedOutAt());
  const [view, setView] = useState<View>('signin');
  // Setup hands over the created account + its one-time recovery key first.
  const [pending, setPending] = useState<{ user: AuthUser; recoveryKey: string } | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retryUntil, setRetryUntil] = useState(0);

  // login / locked
  const [loginName, setLoginName] = useState(remembered?.username ?? '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [pin, setPin] = useState('');
  // After an explicit sign-out the password is required; the passcode pad is
  // offered as a link instead. On a locked session it is the other way round.
  const [usePassword, setUsePassword] = useState(
    mode === 'locked' ? false : signedOut || !remembered?.hasPasscode
  );
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstField.current?.focus();
  }, [mode, usePassword, view]);

  useEffect(() => {
    if (!retryUntil) return;
    const timer = window.setInterval(() => {
      if (Date.now() >= retryUntil) {
        setRetryUntil(0);
        setError('');
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [retryUntil]);

  const waitSeconds = retryUntil ? Math.max(1, Math.ceil((retryUntil - Date.now()) / 1000)) : 0;

  const finish = (user: AuthUser) => {
    startSession(user);
    setPassword('');
    setPin('');
    onAuthenticated();
  };

  const submitLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const outcome = await authenticate(loginName, password);
      if (outcome.ok && outcome.user) {
        finish(outcome.user);
        return;
      }
      if (outcome.reason === 'locked' && outcome.retryAfterMs) {
        setRetryUntil(Date.now() + outcome.retryAfterMs);
        setError(`Too many failed attempts. Try again in ${Math.ceil(outcome.retryAfterMs / 1000)}s.`);
      } else if (outcome.reason === 'no-users') {
        setError('No account exists yet. Reload to start setup.');
      } else {
        setError('Invalid username or password.');
      }
      setPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submitPin = async (value: string) => {
    if (busy || value.length !== PASSCODE_LENGTH) return;
    setBusy(true);
    setError('');
    try {
      // Locked: prove it to the session that already exists.
      // Remembered: this is a fresh sign-in for that one account.
      const outcome =
        mode === 'locked'
          ? await unlockSession(value)
          : remembered
            ? await authenticateWithPasscode(remembered.id, value)
            : { ok: false as const, reason: 'invalid' as const };
      if (outcome.ok) {
        setPin('');
        if ('user' in outcome && outcome.user) finish(outcome.user);
        else onAuthenticated();
        return;
      }
      if (outcome.retryAfterMs) {
        setRetryUntil(Date.now() + outcome.retryAfterMs);
        setError(`Too many wrong passcodes. Try again in ${Math.ceil(outcome.retryAfterMs / 1000)}s.`);
      } else if (outcome.reason === 'no-session') {
        setError('That session ended. Sign in with your password.');
        setUsePassword(true);
      } else {
        setError('Wrong passcode.');
      }
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  const pressPin = (digit: string) => {
    if (busy || waitSeconds > 0) return;
    const next = (pin + digit).slice(0, PASSCODE_LENGTH);
    setPin(next);
    if (next.length === PASSCODE_LENGTH) void submitPin(next);
  };

  const submitUnlockPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const outcome = await unlockSession(password);
      if (outcome.ok) {
        setPassword('');
        onAuthenticated();
        return;
      }
      if (outcome.reason === 'no-session') {
        setError('That session ended. Sign in again.');
        setUsePassword(true);
      } else {
        setError('Password not correct.');
      }
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  // After a sign-out the password form is the default (see usePassword above),
  // but choosing the passcode explicitly still opens the pad.
  const rememberedView = mode === 'login' && !!remembered?.hasPasscode && !usePassword;
  const keypadVisible = (mode === 'locked' || rememberedView) && !usePassword;

  // The pad must not be mouse-only: physical digits type, Backspace deletes and
  // Enter submits a complete code. Text fields keep their own keys.
  useEffect(() => {
    if (!keypadVisible) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (/^\d$/.test(event.key)) {
        event.preventDefault();
        pressPin(event.key);
        return;
      }
      if (event.key === 'Backspace') {
        event.preventDefault();
        if (!busy) setPin((v) => v.slice(0, -1));
        return;
      }
      if (event.key === 'Enter' && pin.length === PASSCODE_LENGTH) {
        event.preventDefault();
        void submitPin(pin);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const title =
    pending
      ? 'Save your recovery key'
      : mode === 'setup'
        ? "Set up Contractor's Stambha"
        : view === 'create'
          ? 'Create another account'
          : view === 'recover'
            ? 'Recover your account'
            : mode === 'locked'
              ? 'Locked'
              : rememberedView
                ? `Welcome back, ${remembered!.name}`
                : 'Sign in';
  const subtitle =
    pending
      ? `@${pending.user.username} is ready. This key is the offline way back in.`
      : mode === 'setup'
        ? 'Create the administrator account for this computer. It stays on this machine only.'
        : view === 'create'
          ? 'A new account starts with its own empty books, jobs and backup folder — completely separate from everyone else on this computer.'
          : view === 'recover'
            ? 'Prove it is your account, then choose a new password.'
            : mode === 'locked'
                ? signedInName
                  ? `Signed in as ${signedInName}.`
                  : 'Enter your passcode to continue.'
                : rememberedView
                  ? `Enter your ${PASSCODE_LENGTH}-digit passcode, or sign in with your password.`
                  : 'Enter your username and password to open the books.';

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-2 mb-6 justify-center">
          <img src={appIcon} alt="" className="w-9 h-9" />
          <span className="text-lg font-semibold text-gray-900">Contractor's Stambha</span>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-lg font-bold text-gray-900">{title}</h1>
              <p className="text-xs text-gray-500 mt-1 mb-4">{subtitle}</p>
            </div>
            {(view !== 'signin' || (mode === 'login' && !signedOut && remembered)) && !pending && (
              <button
                type="button"
                onClick={() => {
                  setView('signin');
                  setError('');
                  setLoginName(remembered?.username ?? '');
                  setUsePassword(true);
                }}
                className="text-xs text-gray-500 hover:text-gray-700 inline-flex items-center gap-1 shrink-0 mt-1"
              >
                <ArrowLeft className="w-3.5 h-3.5" /> Back
              </button>
            )}
          </div>

          {notice && <p className="mb-3 rounded-lg bg-white border border-gray-200 border-l-2 border-l-amber-600 px-3 py-2 text-xs text-amber-800">{notice}</p>}
          {signedOut && mode === 'login' && view === 'signin' && !pending && (
            <p className="mb-3 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs text-emerald-800" data-testid="signed-out-note">
              Signed out safely. Your books are closed until someone signs in.
            </p>
          )}

          {!pending && <ProblemText>{error}</ProblemText>}

          {pending && (
            <RecoveryKeyPanel
              recoveryKey={pending.recoveryKey}
              username={pending.user.username}
              doneLabel="Continue to my books"
              onDone={() => {
                const user = pending.user;
                setPending(null);
                finish(user);
              }}
            />
          )}

          {!pending && ((mode === 'setup' && view === 'signin') || view === 'create') && (
            <CreateAccountView
              firstRun={mode === 'setup'}
              onCancel={mode === 'setup' ? undefined : () => setView('signin')}
              onCreated={(user, recoveryKey) => setPending({ user, recoveryKey })}
            />
          )}

          {!pending && view === 'recover' && (
            <RecoveryView
              initialUsername={remembered?.username ?? ''}
              onCancel={() => setView('signin')}
              onRecovered={(user) => finish(user)}
            />
          )}

          {!pending && mode === 'login' && view === 'signin' && usePassword && (
            <form onSubmit={submitLogin} className="space-y-3" data-testid="login-form">
              <Field label="Username">
                <div className="relative">
                  <User className="w-4 h-4 text-gray-400 absolute left-3 top-2.5" />
                  <input
                    ref={firstField}
                    className={cn(inputClass, 'pl-9')}
                    value={loginName}
                    onChange={(e) => setLoginName(e.target.value)}
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    aria-label="Username"
                  />
                </div>
              </Field>
              <PasswordField
                label="Password"
                value={password}
                onChange={setPassword}
                show={showPassword}
                onToggleShow={() => setShowPassword((v) => !v)}
              />
              <button type="submit" disabled={busy || waitSeconds > 0} className={primaryButton()}>
                {busy ? 'Checking…' : waitSeconds > 0 ? `Wait ${waitSeconds}s` : 'Sign in'}
              </button>

              {remembered?.hasPasscode && (
                <button
                  type="button"
                  onClick={() => {
                    setUsePassword(false);
                    setError('');
                    setPin('');
                  }}
                  className="w-full text-xs font-medium text-blue-700 hover:text-blue-800 py-1"
                  data-testid="use-passcode"
                >
                  Use the {PASSCODE_LENGTH}-digit passcode for @{remembered.username}
                </button>
              )}

              <div className="flex items-center justify-between pt-2 border-t border-gray-100 text-xs">
                <button type="button" onClick={() => setView('recover')} className="inline-flex items-center gap-1 text-gray-600 hover:text-gray-800" data-testid="forgot-password">
                  <LifeBuoy className="w-3.5 h-3.5" /> Forgot password?
                </button>
                <button type="button" onClick={() => setView('create')} className="inline-flex items-center gap-1 text-blue-700 hover:text-blue-800 font-medium" data-testid="create-account-link">
                  <UserPlus className="w-3.5 h-3.5" /> Create account
                </button>
              </div>
            </form>
          )}

          {!pending && (mode === 'locked' || rememberedView) && (
            <div data-testid="lock-screen">
              {usePassword && mode === 'locked' ? (
                <form onSubmit={submitUnlockPassword} className="space-y-3">
                  <PasswordField
                    label="Password"
                    value={password}
                    onChange={setPassword}
                    show={showPassword}
                    onToggleShow={() => setShowPassword((v) => !v)}
                  />
                  <button type="submit" disabled={busy} className={primaryButton()}>
                    {busy ? 'Checking…' : 'Unlock'}
                  </button>
                  {remembered?.hasPasscode && (
                    <button type="button" onClick={() => setUsePassword(false)} className="w-full text-xs text-blue-700 hover:text-blue-800">
                      Use the passcode instead
                    </button>
                  )}
                </form>
              ) : !usePassword ? (
                <>
                  <div className="flex justify-center gap-2 mb-2" aria-label="Passcode">
                    {Array.from({ length: PASSCODE_LENGTH }).map((_, i) => (
                      <span
                        key={i}
                        role="img"
                        aria-label={i < pin.length ? 'Digit entered' : 'Digit empty'}
                        className={cn('w-3 h-3 rounded-full border', i < pin.length ? 'bg-blue-600 border-blue-600' : 'bg-white border-gray-300')}
                      />
                    ))}
                  </div>
                  <p className="text-[11px] text-gray-500 text-center mb-3">Type the digits on your keyboard, or tap the keypad.</p>
                  <div className="grid grid-cols-3 gap-2">
                    {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => pressPin(d)}
                        disabled={busy || waitSeconds > 0}
                        className="py-3 rounded-lg border border-gray-200 text-base font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-50"
                      >
                        {d}
                      </button>
                    ))}
                    <button type="button" onClick={() => setUsePassword(true)} className="py-3 rounded-lg text-[11px] text-gray-500 hover:bg-gray-50">
                      Use password
                    </button>
                    <button
                      type="button"
                      onClick={() => pressPin('0')}
                      disabled={busy || waitSeconds > 0}
                      className="py-3 rounded-lg border border-gray-200 text-base font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-50"
                    >
                      0
                    </button>
                    <button
                      type="button"
                      onClick={() => setPin((v) => v.slice(0, -1))}
                      disabled={busy}
                      className="py-3 rounded-lg border border-gray-200 flex items-center justify-center text-gray-600 hover:bg-gray-50"
                      aria-label="Delete last digit"
                    >
                      <Delete className="w-4 h-4" />
                    </button>
                  </div>
                  {mode === 'login' && (
                    <div className="flex items-center justify-between pt-3 text-xs">
                      <button type="button" onClick={() => setView('recover')} className="text-gray-600 hover:text-gray-800">
                        Forgot password?
                      </button>
                      <button type="button" onClick={() => setView('create')} className="font-medium text-blue-700 hover:text-blue-800">
                        Create account
                      </button>
                    </div>
                  )}
                </>
              ) : null}
            </div>
          )}

          {!pending && mode === 'setup' && (
            <p className="mt-4 text-[11px] text-gray-500">
              Passwords and recovery answers are stored as salted hashes on this computer. Keep your
              recovery key somewhere safe — it is the only offline way back in.
            </p>
          )}
        </div>

        <p className="mt-4 text-center text-[11px] text-gray-400">
          Sign-in protects this screen, not the files on disk — keep the computer itself secure.
        </p>
      </div>
    </div>
  );
}
