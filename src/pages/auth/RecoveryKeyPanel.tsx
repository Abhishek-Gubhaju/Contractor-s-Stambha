// ============================================================================
// RecoveryKeyPanel — the one moment a recovery key exists in readable form.
//
// The key is generated locally, shown here, and stored only as a hash. If the
// person closes this panel without saving it, it is gone for good and can only
// be replaced from Settings (password required). So the panel makes saving it
// the explicit next step: copy, download, and a tick to confirm.
// ============================================================================
import { useState } from 'react';
import { Check, Copy, Download, KeyRound, ShieldAlert } from 'lucide-react';

export function RecoveryKeyPanel({
  recoveryKey,
  username,
  onDone,
  doneLabel = 'I have saved this key',
  onCancel,
}: {
  recoveryKey: string;
  username: string;
  onDone: () => void;
  doneLabel?: string;
  onCancel?: () => void;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [saved, setSaved] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  const download = () => {
    const text = [
      "Contractor's Stambha account recovery key",
      '',
      `Account: @${username}`,
      `Key:     ${recoveryKey}`,
      '',
      'Keep this somewhere private and offline. It is the only way back into this',
      'account if the password is forgotten. This file is the only copy — the app',
      'stores a hash, not the key.',
      '',
      `Created: ${new Date().toLocaleString()}`,
    ].join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `Stambha-recovery-${username}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-3" data-testid="recovery-key-panel">
      <div className="flex items-start gap-2 rounded-lg bg-white border border-gray-200 border-l-2 border-l-amber-600 px-3 py-2">
        <ShieldAlert className="w-4 h-4 text-amber-700 mt-0.5 shrink-0" />
        <p className="text-[11px] text-amber-900">
          This key is shown <strong>once</strong>. Write it down or download it now — nobody, including an administrator,
          can read it back later. It only works on this computer.
        </p>
      </div>

      <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-4 text-center">
        <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1 flex items-center justify-center gap-1">
          <KeyRound className="w-3.5 h-3.5" /> Recovery key for @{username}
        </p>
        <p className="font-mono text-lg sm:text-xl tracking-[0.15em] text-gray-900 select-all" data-testid="recovery-key-value">
          {recoveryKey}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-lg px-3 py-2"
        >
          {copyState === 'copied' ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
          {copyState === 'copied' ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          onClick={download}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-lg px-3 py-2"
        >
          <Download className="w-4 h-4" /> Download as text file
        </button>
      </div>
      {copyState === 'failed' && (
        <p className="text-[11px] text-rose-700">Copying is blocked here — select the key and copy it by hand, or download it.</p>
      )}

      <label className="flex items-start gap-2 text-xs text-gray-700">
        <input type="checkbox" className="mt-0.5" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>I have saved this recovery key somewhere safe and understand it cannot be shown again.</span>
      </label>

      <div className="flex justify-end gap-2 pt-1">
        {onCancel && (
          <button type="button" onClick={onCancel} className="px-3 py-2 text-sm text-gray-600 hover:text-gray-800">
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={onDone}
          disabled={!saved}
          className="px-4 py-2 text-sm font-semibold text-white bg-gray-900 hover:bg-gray-800 disabled:opacity-50 rounded-lg"
          data-testid="recovery-key-done"
        >
          {doneLabel}
        </button>
      </div>
    </div>
  );
}
