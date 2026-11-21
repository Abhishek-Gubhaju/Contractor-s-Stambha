// ============================================================================
// CreateAccountView — a new account, with recovery set up in the same step.
//
// Used for the very first administrator (setup) and for "Create another
// account" on the sign-in screen. Every account gets its own data namespace and
// its own backup folder, so this is the one screen that has to be safe: strong
// password policy, three security questions, and a recovery key issued once.
// ============================================================================
import { useMemo, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import {
  PASSCODE_LENGTH,
  createAccount,
  passcodeProblem,
  passwordProblems,
  passwordStrength,
} from '../../services/auth/authService';
import {
  RECOVERY_QUESTION_COUNT,
  answerProblem,
  recoveryQuestionOptions,
} from '../../services/auth/recovery';
import type { AuthUser } from '../../services/auth/authService';
import { Field, PasswordField, ProblemText, inputClass, primaryButton } from './authFields';

const STRENGTH_LABELS = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];
const QUESTIONS = recoveryQuestionOptions();

interface AnswerRow {
  questionId: string;
  answer: string;
}

export function CreateAccountView({
  firstRun,
  onCreated,
  onCancel,
}: {
  firstRun: boolean;
  onCreated: (user: AuthUser, recoveryKey: string) => void;
  onCancel?: () => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [withPasscode, setWithPasscode] = useState(false);
  const [passcode, setPasscode] = useState('');
  const [answers, setAnswers] = useState<AnswerRow[]>([0, 1, 2].map(() => ({ questionId: '', answer: '' })));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Each question can only be used once; offer the rest of the list.
  const optionsFor = useMemo(
    () => (index: number) => QUESTIONS.filter((q) => q.id === answers[index].questionId || !answers.some((a) => a.questionId === q.id)),
    [answers]
  );

  const setAnswer = (index: number, patch: Partial<AnswerRow>) => {
    setAnswers((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    if (password !== confirm) return setError('The two passwords do not match.');
    const problems = passwordProblems(password, username);
    if (problems.length) return setError(problems[0]);
    if (withPasscode) {
      const pinIssue = passcodeProblem(passcode);
      if (pinIssue) return setError(pinIssue);
    }
    if (answers.some((a) => !a.questionId)) return setError(`Choose ${RECOVERY_QUESTION_COUNT} security questions.`);
    for (const [i, row] of answers.entries()) {
      const issue = answerProblem(row.answer);
      if (issue) return setError(`Answer ${i + 1}: ${issue}`);
    }

    setBusy(true);
    try {
      const { user, recoveryKey } = await createAccount({
        username,
        password,
        displayName,
        admin: firstRun,
        passcode: withPasscode ? passcode : null,
        recovery: { answers },
      });
      setPassword('');
      setConfirm('');
      setPasscode('');
      onCreated(user, recoveryKey);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3" data-testid={firstRun ? 'setup-form' : 'create-account-form'}>
      <ProblemText>{error}</ProblemText>

      <Field label="Your name">
        <input className={inputClass} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Your full name" autoComplete="name" />
      </Field>
      <Field label="Username" hint="Letters, numbers, dots, dashes or underscores. Used to sign in.">
        <input
          className={inputClass}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="your.name"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
        />
      </Field>
      <PasswordField
        label="Password"
        hint={password ? `Strength: ${STRENGTH_LABELS[passwordStrength(password)]} · at least 10 characters` : 'At least 10 characters. It cannot be reset without your recovery answers or key.'}
        value={password}
        onChange={setPassword}
        show={showPassword}
        onToggleShow={() => setShowPassword((v) => !v)}
        autoComplete="new-password"
      />
      <Field label="Confirm password">
        <input className={inputClass} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" aria-label="Confirm password" />
      </Field>

      <div className="rounded-lg border border-gray-200 p-3">
        <label className="flex items-start gap-2 text-xs text-gray-700">
          <input type="checkbox" className="mt-0.5" checked={withPasscode} onChange={(e) => setWithPasscode(e.target.checked)} />
          <span>
            Add a {PASSCODE_LENGTH}-digit passcode
            <span className="block text-[11px] text-gray-500">Optional. Unlocks a locked screen quickly; never replaces the password.</span>
          </span>
        </label>
        {withPasscode && (
          <input
            className={`${inputClass} mt-2 tracking-[0.4em] font-mono`}
            inputMode="numeric"
            maxLength={PASSCODE_LENGTH}
            value={passcode}
            onChange={(e) => setPasscode(e.target.value.replace(/\D/g, '').slice(0, PASSCODE_LENGTH))}
            placeholder="••••••"
            aria-label="Passcode"
          />
        )}
      </div>

      <div className="rounded-lg border border-blue-100 bg-blue-50/50 p-3 space-y-2">
        <p className="text-xs font-semibold text-blue-900 flex items-center gap-1">
          <ShieldCheck className="w-4 h-4" /> Account recovery
        </p>
        <p className="text-[11px] text-blue-900/80">
          Choose three questions. Answering any <strong>two</strong> correctly lets you set a new password without losing this
          account’s data. Answers are stored only as salted hashes.
        </p>
        {answers.map((row, index) => (
          <div key={index} className="space-y-1">
            <select
              className={inputClass}
              value={row.questionId}
              onChange={(e) => setAnswer(index, { questionId: e.target.value })}
              aria-label={`Security question ${index + 1}`}
            >
              <option value="">Choose question {index + 1}…</option>
              {optionsFor(index).map((q) => (
                <option key={q.id} value={q.id}>{q.label}</option>
              ))}
            </select>
            <input
              className={inputClass}
              value={row.answer}
              onChange={(e) => setAnswer(index, { answer: e.target.value })}
              placeholder="Your answer"
              aria-label={`Answer ${index + 1}`}
              autoComplete="off"
            />
          </div>
        ))}
        <p className="text-[11px] text-blue-900/70">A recovery key is generated after this step and shown once.</p>
      </div>

      <button type="submit" disabled={busy} className={primaryButton()}>
        {busy ? 'Creating…' : firstRun ? 'Create account and open' : 'Create account'}
      </button>
      {onCancel && (
        <button type="button" onClick={onCancel} className="w-full text-xs text-gray-500 hover:text-gray-700">
          Back to sign in
        </button>
      )}
    </form>
  );
}

export default CreateAccountView;
