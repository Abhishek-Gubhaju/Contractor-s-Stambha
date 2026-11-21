// ============================================================================
// RecoveryCard — Settings side of account recovery.
//
// Shows whether recovery is armed, lets the signed-in person replace the three
// questions (password proved again), and issue a fresh recovery key. A key is
// displayed once by RecoveryKeyPanel; rotating invalidates the old one
// immediately, which is the right response to "I think someone saw my key".
// ============================================================================
import { useState } from 'react';
import { KeyRound, LifeBuoy, ShieldQuestion } from 'lucide-react';
import { notify } from '../../components/ui/DialogHost';
import {
  recoveryStatus,
  rotateRecoveryKey,
  setRecoveryQuestions,
} from '../../services/auth/authService';
import { RECOVERY_QUESTIONS, RECOVERY_QUESTION_COUNT, answerProblem } from '../../services/auth/recovery';
import { RecoveryKeyPanel } from '../auth/RecoveryKeyPanel';
import { PasswordField, inputClass } from '../auth/authFields';

const QUESTIONS = RECOVERY_QUESTIONS;

export function RecoveryCard({ userId, username }: { userId: string; username: string }) {
  const [status, setStatus] = useState(() => recoveryStatus(userId));
  const [open, setOpen] = useState<'none' | 'questions' | 'key'>('none');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [answers, setAnswers] = useState([0, 1, 2].map(() => ({ questionId: '', answer: '' })));
  const [newKey, setNewKey] = useState('');
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) => notify(e instanceof Error ? e.message : String(e), 'error');
  const refresh = () => setStatus(recoveryStatus(userId));

  const reset = () => {
    setOpen('none');
    setPassword('');
    setAnswers([0, 1, 2].map(() => ({ questionId: '', answer: '' })));
    setNewKey('');
  };

  const saveQuestions = async () => {
    if (busy) return;
    if (answers.some((a) => !a.questionId)) return notify(`Choose ${RECOVERY_QUESTION_COUNT} questions.`, 'error');
    for (const [i, row] of answers.entries()) {
      const issue = answerProblem(row.answer);
      if (issue) return notify(`Answer ${i + 1}: ${issue}`, 'error');
    }
    setBusy(true);
    try {
      await setRecoveryQuestions(userId, password, { answers });
      refresh();
      reset();
      notify('Recovery questions updated.');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const makeKey = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const key = await rotateRecoveryKey(userId, password);
      setNewKey(key);
      setPassword('');
      refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white rounded-xl border p-6" data-testid="recovery-card">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold mb-1 flex items-center gap-1.5">
            <LifeBuoy className="w-5 h-5 text-gray-500" /> Account recovery
          </h2>
          <p className="text-xs text-gray-500 max-w-xl">
            If the password is forgotten, two of three security answers or the recovery key reset it without
            losing this account’s data.
          </p>
        </div>
        <span
          className={`text-[11px] font-medium rounded-full px-2 py-0.5 border ${
            status.questions >= RECOVERY_QUESTION_COUNT || status.hasKey
              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
              : 'bg-amber-50 text-amber-700 border-amber-200'
          }`}
          data-testid="recovery-status"
        >
          {status.questions >= RECOVERY_QUESTION_COUNT || status.hasKey ? 'Recovery armed' : 'Not set up'}
        </span>
      </div>

      <div className="mt-3 grid sm:grid-cols-3 gap-3 text-xs text-gray-600">
        <div className="rounded-lg border border-gray-100 px-3 py-2">
          <p className="text-[10px] uppercase tracking-wide text-gray-400">Security questions</p>
          <p className="font-medium text-gray-800">{status.questions} / {RECOVERY_QUESTION_COUNT} set</p>
        </div>
        <div className="rounded-lg border border-gray-100 px-3 py-2">
          <p className="text-[10px] uppercase tracking-wide text-gray-400">Recovery key</p>
          <p className="font-medium text-gray-800">{status.hasKey ? 'Issued' : 'Not issued'}</p>
        </div>
        <div className="rounded-lg border border-gray-100 px-3 py-2">
          <p className="text-[10px] uppercase tracking-wide text-gray-400">Last recovery</p>
          <p className="font-medium text-gray-800">{status.usedAt ? new Date(status.usedAt).toLocaleDateString() : 'Never used'}</p>
        </div>
      </div>

      {newKey ? (
        <div className="mt-4">
          <RecoveryKeyPanel
            recoveryKey={newKey}
            username={username}
            doneLabel="I have saved the new key"
            onDone={() => {
              setNewKey('');
              setOpen('none');
              notify('New recovery key issued. The previous key no longer works.');
            }}
          />
        </div>
      ) : open === 'none' ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setOpen('questions')}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-lg px-3 py-1.5"
            data-testid="recovery-edit-questions"
          >
            <ShieldQuestion className="w-4 h-4" /> {status.questions > 0 ? 'Replace questions' : 'Set up questions'}
          </button>
          <button
            type="button"
            onClick={() => setOpen('key')}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-lg px-3 py-1.5"
            data-testid="recovery-new-key"
          >
            <KeyRound className="w-4 h-4" /> {status.hasKey ? 'Issue a new recovery key' : 'Generate recovery key'}
          </button>
        </div>
      ) : (
        <div className="mt-4 space-y-3 border-t border-gray-100 pt-4">
          <p className="text-xs text-gray-500">
            {open === 'questions' ? 'Replace the three questions. Your recovery key (if any) stays valid.' : 'A new key replaces the old one immediately. It is shown once.'}
          </p>
          <PasswordField
            label="Confirm with your password"
            value={password}
            onChange={setPassword}
            show={showPassword}
            onToggleShow={() => setShowPassword((v) => !v)}
            ariaLabel="Password to confirm"
          />

          {open === 'questions' && (
            <div className="space-y-2">
              {answers.map((row, index) => (
                <div key={index} className="grid sm:grid-cols-2 gap-2">
                  <select
                    className={inputClass}
                    value={row.questionId}
                    onChange={(e) => setAnswers((rows) => rows.map((r, i) => (i === index ? { ...r, questionId: e.target.value } : r)))}
                    aria-label={`Recovery question ${index + 1}`}
                  >
                    <option value="">Choose question {index + 1}…</option>
                    {QUESTIONS.filter((q) => q.id === row.questionId || !answers.some((a) => a.questionId === q.id)).map((q) => (
                      <option key={q.id} value={q.id}>{q.label}</option>
                    ))}
                  </select>
                  <input
                    className={inputClass}
                    value={row.answer}
                    onChange={(e) => setAnswers((rows) => rows.map((r, i) => (i === index ? { ...r, answer: e.target.value } : r)))}
                    placeholder="Answer"
                    aria-label={`Recovery answer ${index + 1}`}
                    autoComplete="off"
                  />
                </div>
              ))}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={reset} className="px-3 py-1.5 text-sm text-gray-600">
              Cancel
            </button>
            <button
              type="button"
              onClick={open === 'questions' ? saveQuestions : makeKey}
              disabled={busy || !password}
              className="px-3 py-1.5 text-sm font-semibold text-white bg-gray-900 hover:bg-gray-800 disabled:opacity-50 rounded-lg"
            >
              {busy ? 'Working…' : open === 'questions' ? 'Save questions' : 'Generate key'}
            </button>
          </div>
        </div>
      )}

      <p className="mt-4 text-[11px] text-gray-500">
        Proving ownership only opens a password reset for this account.
      </p>
    </div>
  );
}

export default RecoveryCard;
