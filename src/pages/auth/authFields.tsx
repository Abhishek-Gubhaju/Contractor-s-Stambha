// ============================================================================
// Small shared pieces of the auth screens: a labelled field, the password
// input with its show/hide control, and the strength hint. Keeping them here
// means the setup, create-account and recovery forms cannot drift apart.
// ============================================================================
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '../../utils';

export const inputClass =
  'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500';

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-gray-600 mb-1">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-gray-500">{hint}</span>}
    </label>
  );
}

export function PasswordField({
  label,
  hint,
  value,
  onChange,
  show,
  onToggleShow,
  autoComplete = 'current-password',
  ariaLabel,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  show: boolean;
  onToggleShow: () => void;
  autoComplete?: string;
  ariaLabel?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <div className="relative">
        <input
          className={cn(inputClass, 'pr-10')}
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          aria-label={ariaLabel || label}
          spellCheck={false}
        />
        <button
          type="button"
          onClick={onToggleShow}
          className="absolute inset-y-0 right-0 px-3 text-gray-500 hover:text-gray-700"
          aria-label={show ? 'Hide password' : 'Show password'}
          tabIndex={-1}
        >
          {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
    </Field>
  );
}

export function ProblemText({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" aria-live="assertive" className="rounded-lg bg-white border border-gray-200 border-l-2 border-l-red-600 px-3 py-2 text-xs text-rose-800">
      {children}
    </p>
  );
}

export function primaryButton(extra = '') {
  return cn(
    'w-full bg-gray-900 hover:bg-gray-800 disabled:opacity-60 text-white text-sm font-semibold rounded-lg px-4 py-2.5',
    extra
  );
}
