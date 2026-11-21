// In-app dialogs.
//
// `window.confirm` / `window.alert` are not implemented by the desktop
// WebView (WKWebView), so a delete guarded by confirm() silently did nothing.
// These helpers render real React UI instead: one <DialogHost /> mounted in
// App serves every page, and callers await a promise.
import { useEffect, useState } from 'react';
import { deleteSecretKind, verifyDeleteSecret } from '../../services/auth/authService';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

interface ConfirmRequest extends ConfirmOptions {
  id: number;
  resolve: (value: boolean) => void;
}

/** A deletion needs the account's own secret, not just a button click. */
export interface DestroyOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

interface DestroyRequest extends DestroyOptions {
  id: number;
  kind: 'passcode' | 'password';
  resolve: (value: boolean) => void;
}

export interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'error';
}

export interface ChoiceOption {
  value: string;
  label: string;
  tone?: 'primary' | 'danger' | 'neutral';
}

export interface ChoiceOptions {
  title?: string;
  message: string;
  options: ChoiceOption[];
  cancelLabel?: string;
}

interface ChoiceRequest extends ChoiceOptions {
  id: number;
  resolve: (value: string | null) => void;
}

let seq = 0;
let current: ConfirmRequest | null = null;
let currentDestroy: DestroyRequest | null = null;
let currentChoice: ChoiceRequest | null = null;
let toasts: Toast[] = [];
const confirmSubs = new Set<(state: ConfirmRequest | null) => void>();
const destroySubs = new Set<(state: DestroyRequest | null) => void>();
const choiceSubs = new Set<(state: ChoiceRequest | null) => void>();
const toastSubs = new Set<(state: Toast[]) => void>();

function emitConfirm() {
  confirmSubs.forEach((fn) => fn(current));
}

function emitDestroy() {
  destroySubs.forEach((fn) => fn(currentDestroy));
}

function emitToasts() {
  toastSubs.forEach((fn) => fn(toasts));
}

function emitChoice() {
  choiceSubs.forEach((fn) => fn(currentChoice));
}

/**
 * Ask a question with more than two answers ("back up and leave", "leave
 * without a backup", "cancel"). Resolves null when dismissed.
 */
export function choiceDialog(options: ChoiceOptions): Promise<string | null> {
  return new Promise((resolve) => {
    currentChoice?.resolve(null);
    currentChoice = { ...options, id: ++seq, resolve };
    emitChoice();
  });
}

function settleChoice(value: string | null) {
  const request = currentChoice;
  currentChoice = null;
  emitChoice();
  request?.resolve(value);
}

/** Ask before a destructive action. Resolves true only when confirmed. */
export function confirmDialog(options: ConfirmOptions | string): Promise<boolean> {
  const opts: ConfirmOptions = typeof options === 'string' ? { message: options } : options;
  return new Promise((resolve) => {
    // A second request supersedes any open one (answers false).
    current?.resolve(false);
    current = { ...opts, id: ++seq, resolve };
    emitConfirm();
  });
}

function settle(value: boolean) {
  const request = current;
  current = null;
  emitConfirm();
  request?.resolve(value);
}

/**
 * Ask for the account's passcode/password before destroying data.
 * Resolves true only when the secret verifies.
 */
export function destroyDialog(options: DestroyOptions | string): Promise<boolean> {
  const opts: DestroyOptions = typeof options === 'string' ? { message: options } : options;
  return new Promise((resolve) => {
    // A second request supersedes any open one (answers false).
    current?.resolve(false);
    currentDestroy?.resolve(false);
    current = null;
    currentDestroy = { ...opts, id: ++seq, kind: deleteSecretKind(), resolve };
    emitConfirm();
    emitDestroy();
  });
}

function settleDestroy(value: boolean) {
  const request = currentDestroy;
  currentDestroy = null;
  emitDestroy();
  request?.resolve(value);
}

/** Non-blocking message, replacing alert(). */
export function notify(message: string, tone: Toast['tone'] = 'info') {
  const toast: Toast = { id: ++seq, message, tone };
  toasts = [...toasts, toast];
  emitToasts();
  if (typeof window !== 'undefined') {
    window.setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== toast.id);
      emitToasts();
    }, tone === 'error' ? 6000 : 4000);
  }
}

export function DialogHost() {
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [destroy, setDestroy] = useState<DestroyRequest | null>(null);
  const [choice, setChoice] = useState<ChoiceRequest | null>(null);
  const [messages, setMessages] = useState<Toast[]>([]);
  const [secret, setSecret] = useState('');
  const [destroyError, setDestroyError] = useState('');
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    confirmSubs.add(setConfirm);
    destroySubs.add(setDestroy);
    choiceSubs.add(setChoice);
    toastSubs.add(setMessages);
    setConfirm(current);
    setDestroy(currentDestroy);
    setChoice(currentChoice);
    setMessages(toasts);
    return () => {
      confirmSubs.delete(setConfirm);
      destroySubs.delete(setDestroy);
      choiceSubs.delete(setChoice);
      toastSubs.delete(setMessages);
    };
  }, []);

  // Each new request starts with an empty field and no stale error.
  useEffect(() => {
    setSecret('');
    setDestroyError('');
    setVerifying(false);
  }, [destroy?.id]);

  const submitDestroy = async () => {
    if (!destroy || verifying) return;
    if (!secret.trim()) {
      setDestroyError(destroy.kind === 'passcode' ? 'Enter your passcode.' : 'Enter your account password.');
      return;
    }
    setVerifying(true);
    let result;
    try {
      result = await verifyDeleteSecret(secret);
    } catch (e) {
      setVerifying(false);
      setDestroyError('Could not check that secret. Try again.');
      return;
    }
    setVerifying(false);
    if (result.ok) {
      settleDestroy(true);
      return;
    }
    setSecret('');
    if (result.reason === 'locked') {
      const secs = Math.max(1, Math.ceil((result.retryAfterMs || 0) / 1000));
      setDestroyError(`Too many wrong attempts. Try again in ${secs}s.`);
    } else if (result.reason === 'no-session') {
      setDestroyError('Your session is no longer active. Sign in again to delete.');
    } else {
      setDestroyError(result.requires === 'passcode' ? 'That passcode is incorrect.' : 'That password is incorrect.');
    }
  };

  useEffect(() => {
    if (!confirm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        settle(false);
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        settle(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirm]);

  useEffect(() => {
    if (!destroy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        settleDestroy(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [destroy]);

  useEffect(() => {
    if (!choice) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        settleChoice(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [choice]);

  return (
    <>
      {choice && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={choice.title || 'Choose'}
          data-testid="choice-dialog"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) settleChoice(null);
          }}
        >
          <div className="w-full max-w-md rounded-xl bg-white border border-gray-200 shadow-xl p-5">
            <h2 className="text-base font-semibold text-gray-900 mb-2">{choice.title || 'Choose an option'}</h2>
            <p className="text-sm text-gray-600 whitespace-pre-line mb-5">{choice.message}</p>
            <div className="flex flex-col gap-2">
              {choice.options.map((option) => (
                <button
                  key={option.value}
                  onClick={() => settleChoice(option.value)}
                  data-testid={`choice-${option.value}`}
                  className={
                    option.tone === 'danger'
                      ? 'w-full text-left px-3 py-2 text-sm rounded-lg bg-rose-600 text-white hover:bg-rose-700'
                      : option.tone === 'neutral'
                        ? 'w-full text-left px-3 py-2 text-sm rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50'
                        : 'w-full text-left px-3 py-2 text-sm rounded-lg bg-slate-900 text-white hover:bg-slate-800'
                  }
                >
                  {option.label}
                </button>
              ))}
              <button
                onClick={() => settleChoice(null)}
                className="mt-1 px-3 py-1.5 text-sm rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 self-end"
                data-testid="choice-cancel"
              >
                {choice.cancelLabel || 'Cancel'}
              </button>
            </div>
          </div>
        </div>
      )}

      {destroy && (
        <div
          className="fixed inset-0 z-[75] flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={destroy.title || 'Confirm deletion'}
          data-testid="destroy-dialog"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) settleDestroy(false);
          }}
        >
          <form
            className="w-full max-w-sm rounded-xl bg-white border border-gray-200 shadow-xl p-5"
            onSubmit={(e) => {
              e.preventDefault();
              void submitDestroy();
            }}
          >
            <h2 className="text-base font-semibold text-gray-900 mb-2">{destroy.title || 'Confirm deletion'}</h2>
            <p className="text-sm text-gray-600 whitespace-pre-line mb-4">{destroy.message}</p>
            <label htmlFor="destroy-secret" className="block text-sm font-medium text-gray-700 mb-1">
              {destroy.kind === 'passcode' ? 'Enter your passcode (or account password)' : 'Enter your account password'}
            </label>
            <input
              id="destroy-secret"
              data-testid="destroy-secret"
              type="password"
              autoComplete="off"
              autoFocus
              value={secret}
              inputMode={destroy.kind === 'passcode' ? 'numeric' : undefined}
              onChange={(e) => {
                setSecret(e.target.value);
                if (destroyError) setDestroyError('');
              }}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm tracking-widest"
            />
            {destroyError && (
              <p className="mt-2 text-xs text-red-600" role="alert" data-testid="destroy-error">{destroyError}</p>
            )}
            <p className="mt-2 text-[11px] text-gray-500">Every deletion is recorded in the security log.</p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => settleDestroy(false)}
                className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50"
                data-testid="destroy-cancel"
              >
                {destroy.cancelLabel || 'Cancel'}
              </button>
              <button
                type="submit"
                disabled={verifying}
                className="px-3 py-1.5 text-sm rounded-lg bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-60"
                data-testid="destroy-confirm"
              >
                {verifying ? 'Checking…' : destroy.confirmLabel || 'Delete'}
              </button>
            </div>
          </form>
        </div>
      )}

      {confirm && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={confirm.title || 'Confirm'}
          data-testid="confirm-dialog"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) settle(false);
          }}
        >
          <div className="w-full max-w-sm rounded-xl bg-white border border-gray-200 shadow-xl p-5">
            <h2 className="text-base font-semibold text-gray-900 mb-2">{confirm.title || 'Are you sure?'}</h2>
            <p className="text-sm text-gray-600 whitespace-pre-line mb-5">{confirm.message}</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => settle(false)}
                className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50"
                data-testid="dialog-cancel"
                autoFocus
              >
                {confirm.cancelLabel || 'Cancel'}
              </button>
              <button
                onClick={() => settle(true)}
                className="px-3 py-1.5 text-sm rounded-lg bg-rose-600 text-white hover:bg-rose-700"
                data-testid="dialog-confirm"
              >
                {confirm.confirmLabel || 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {messages.length > 0 && (
        <div className="fixed bottom-4 right-4 z-[80] flex flex-col gap-2 max-w-sm" aria-live="polite">
          {messages.map((t) => (
            <div
              key={t.id}
              className={`rounded-lg px-4 py-2.5 text-sm shadow-lg border ${
                t.tone === 'error'
                  ? 'bg-red-50 border-red-200 text-red-800'
                  : 'bg-slate-900 border-slate-900 text-white'
              }`}
              data-testid="toast"
            >
              {t.message}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
