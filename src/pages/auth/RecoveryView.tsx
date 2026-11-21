// ============================================================================
// RecoveryView — get back into an account when the password is gone.
//
// Three steps, each independently rate-limited by the service:
//   1. name the account
//   2. prove ownership — two of three security answers, or the recovery key
//   3. set a new password (the old one never needs to be known)
//
// The ticket from step 2 lasts ten minutes and is single use. Nothing here can
// read another account's books: proving ownership only opens a reset, and the
// reset itself is logged.
// ============================================================================
import { useState } from 'react';
import { KeyRound, LifeBuoy, ShieldQuestion } from 'lucide-react';
import {
  authenticate,
  passwordProblems,
  recoveryChallenge,
  resetPasswordWithRecovery,
  verifyRecovery,
  type AuthUser,
  type RecoveryChallenge,
} from '../../services/auth/authService';
import type { RecoveryTicket } from '../../services/auth/recovery';
import { Field, PasswordField, ProblemText, inputClass, primaryButton } from './authFields';

type Step = 'find' | 'prove' | 'reset';

export function RecoveryView({
  initialUsername = '',
  onCancel,
  onRecovered,
}: {
  initialUsername?: string;
  onCancel: () => void;
  onRecovered: (user: AuthUser) => void;
}) {
  const [step, setStep] = useState<Step>('find');
  const [username, setUsername] = useState(initialUsername);
  const [challenge, setChallenge] = useState<RecoveryChallenge | null>(null);
  const [answers, setAnswers] = useState<string[]>(['', '', '']);
  const [useKey, setUseKey] = useState(false);
  const [key, setKey] = useState('');
  const [ticket, setTicket] = useState<RecoveryTicket | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const wait = (ms?: number) => (ms && ms > 0 ? ` Try again in ${Math.ceil(ms / 1000)}s.` : '');

  const find = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const found = recoveryChallenge(username);
      if (!found.ok) {
        setError(
          found.reason === 'locked'
            ? `Too many recovery attempts.${wait(found.retryAfterMs)}`
            : 'That account has no recovery set up on this computer. Ask an administrator to reset the password from Settings.'
        );
        return;
      }
      setChallenge(found);
      setUseKey(false);
      setStep('prove');
    } finally {
      setBusy(false);
    }
  };

  const prove = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!challenge?.userId || busy) return;
    setError('');
    setBusy(true);
    try {
      const result = await verifyRecovery(challenge.userId, useKey ? { key } : { answers });
      if (!result.ok) {
        setError(
          result.reason === 'locked'
            ? `Too many recovery attempts.${wait(result.retryAfterMs)}`
            : useKey
              ? 'That recovery key is not correct.'
              : `Not enough correct answers (${result.matched ?? 0} of 3). You need two.`
        );
        return;
      }
      setTicket(result.ticket);
      setStep('reset');
    } finally {
      setBusy(false);
    }
  };

  const reset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ticket || busy) return;
    setError('');
    if (password !== confirm) return setError('The two passwords do not match.');
    const problems = passwordProblems(password, challenge?.username || '');
    if (problems.length) return setError(problems[0]);
    setBusy(true);
    try {
      const outcome = await resetPasswordWithRecovery(ticket.token, password);
      if (!outcome.ok || !outcome.username) {
        setError(outcome.message || 'The password could not be changed.');
        return;
      }
      // Sign straight in with the password just set — ownership was proved.
      const signedIn = await authenticate(outcome.username, password);
      if (!signedIn.ok || !signedIn.user) {
        setError('Password changed, but signing in failed. Return to sign in and use the new password.');
        return;
      }
      setPassword('');
      setConfirm('');
      onRecovered(signedIn.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3" data-testid="recovery-view">
      <div className="flex items-start gap-2 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2">
        <LifeBuoy className="w-4 h-4 text-slate-600 mt-0.5 shrink-0" />
        <p className="text-[11px] text-slate-700">
          Recovery works offline on this computer. Your data stays where it is — only the password changes.
        </p>
      </div>

      <ProblemText>{error}</ProblemText>

      {step === 'find' && (
        <form onSubmit={find} className="space-y-3">
          <Field label="Account username" hint="The username you sign in with, not your display name.">
            <input
              className={inputClass}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
              aria-label="Account username"
            />
          </Field>
          <button type="submit" disabled={busy || !username.trim()} className={primaryButton()}>
            {busy ? 'Checking…' : 'Continue'}
          </button>
        </form>
      )}

      {step === 'prove' && challenge && (
        <form onSubmit={prove} className="space-y-3">
          <p className="text-xs text-gray-600">
            Recovering <span className="font-medium">@{challenge.username}</span>
            {challenge.displayName ? ` (${challenge.displayName})` : ''}.
          </p>
          {challenge.hasKey && (
            <div className="flex gap-1 rounded-lg border border-gray-200 p-1 text-xs">
              <button
                type="button"
                onClick={() => setUseKey(false)}
                className={`flex-1 rounded px-2 py-1.5 ${!useKey ? 'bg-blue-50 text-blue-800 font-medium' : 'text-gray-600'}`}
              >
                <ShieldQuestion className="inline w-3.5 h-3.5 mr-1" /> Security questions
              </button>
              <button
                type="button"
                onClick={() => setUseKey(true)}
                className={`flex-1 rounded px-2 py-1.5 ${useKey ? 'bg-blue-50 text-blue-800 font-medium' : 'text-gray-600'}`}
              >
                <KeyRound className="inline w-3.5 h-3.5 mr-1" /> Recovery key
              </button>
            </div>
          )}

          {useKey ? (
            <Field label="Recovery key" hint="Five groups of four characters. Dashes and capitals are optional.">
              <input
                className={`${inputClass} font-mono tracking-wider`}
                value={key}
                onChange={(e) => setKey(e.target.value.toUpperCase())}
                placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"
                autoFocus
                aria-label="Recovery key"
                spellCheck={false}
              />
            </Field>
          ) : (
            <>
              <p className="text-[11px] text-gray-500">Answer any two of these three questions.</p>
              {(challenge.questions || []).map((q, index) => (
                <Field key={q.id} label={q.label}>
                  <input
                    className={inputClass}
                    value={answers[index] || ''}
                    onChange={(e) => setAnswers((rows) => rows.map((a, i) => (i === index ? e.target.value : a)))}
                    autoComplete="off"
                    aria-label={`Answer to ${q.label}`}
                  />
                </Field>
              ))}
            </>
          )}

          <button type="submit" disabled={busy} className={primaryButton()}>
            {busy ? 'Checking…' : 'Verify and continue'}
          </button>
          <button type="button" onClick={() => setStep('find')} className="w-full text-xs text-gray-500 hover:text-gray-700">
            Use a different account
          </button>
        </form>
      )}

      {step === 'reset' && (
        <form onSubmit={reset} className="space-y-3">
          <p className="text-xs text-gray-600">Ownership verified. Choose a new password for @{challenge?.username}.</p>
          <PasswordField
            label="New password"
            value={password}
            onChange={setPassword}
            show={showPassword}
            onToggleShow={() => setShowPassword((v) => !v)}
            autoComplete="new-password"
            ariaLabel="New password"
          />
          <Field label="Confirm new password">
            <input
              className={inputClass}
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              aria-label="Confirm new password"
            />
          </Field>
          <button type="submit" disabled={busy || !password || !confirm} className={primaryButton()}>
            {busy ? 'Saving…' : 'Set password and sign in'}
          </button>
        </form>
      )}

      <button type="button" onClick={onCancel} className="w-full text-xs text-gray-500 hover:text-gray-700">
        Back to sign in
      </button>
    </div>
  );
}

export default RecoveryView;
