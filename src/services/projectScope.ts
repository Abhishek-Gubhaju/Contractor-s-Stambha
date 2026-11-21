// ============================================================================
// projectScope — EVERY business dataset belongs to ONE project.
//
// Storage is namespaced per project: `<base>::<PROJECT_ID>`. The active project
// is a single persisted selection, so switching jobs swaps the whole workspace
// without any record carrying a project column. Only sign-in/security, machine
// preferences (theme, backup location, backup history) and the job registry
// itself stay global — everything a company would print, file or report is
// scoped: BOQ, DSR, milestones, Gantt, POs, billing, workers, staff, attendance,
// payroll, the double-entry ledger, accounts, bill links, parties, cost codes,
// stock, commitments, document items, attachments, tax settings and the company
// letterhead. Two jobs — even of two different companies — therefore cannot see
// each other's figures.
//
// Compatibility: data written before scoping lived under the bare key and
// belongs to the job that was open when the upgrade happened. That job is
// recorded once as the SCOPE OWNER; `keyFor()` keeps falling back to the bare
// keys for it, so nothing is lost and nothing leaks into another job. If no
// owner is recorded yet the original job (PRJ-001) is assumed, which is exactly
// what older builds did. `migrateProjectScope()` copies pre-scope data into the
// owner's scoped keys once and records a backup manifest, leaving the originals
// untouched as the recovery copy.
// ============================================================================
import { useCallback, useEffect, useState } from 'react';

export const ACTIVE_PROJECT_KEY = 'contractoros_active_project';
export const DEFAULT_PROJECT_ID = 'PRJ-001';
const SCOPE_SEPARATOR = '::';
export const SCOPE_MIGRATED_KEY = 'contractoros_scope_migrated_v1';
export const SCOPE_BACKUP_KEY = 'contractoros_scope_backup';
/** The job that owns data written before project scoping existed. */
export const SCOPE_OWNER_KEY = 'contractoros_scope_owner';
export const PROJECT_CHANGED_EVENT = 'contractoros:project-changed';

/**
 * Every business key that is stored once per project.
 *
 * This is the single authoritative list for adoption (migration); every
 * service reads/writes through `readScoped`/`writeScoped`, and the backup
 * layout mirrors it (guarded by a test), so a new job always starts from a
 * clean, separate set of records.
 */
export const SCOPED_BASES = [
  // ── Site / planning ────────────────────────────────────────────────────
  'contractoros_boq',
  'contractoros_dsr',
  'contractoros_dsr_deleted',
  'contractoros_milestones',
  'contractoros_po',
  'contractoros_billing_entries',
  'contractoros_gantt_activities',
  'contractoros_gantt_dependencies',
  // ── People / payroll ───────────────────────────────────────────────────
  'contractoros_labor',
  'contractoros_labor_deleted',
  'contractoros_staff',
  'contractoros_staff_deleted',
  'contractoros_worker_rates',
  'contractoros_attendance',
  'contractoros_staff_attendance',
  'contractoros_labour_tx',
  'contractoros_payroll_runs',
  // ── Accounting / finance ───────────────────────────────────────────────
  'contractoros_entries',
  'contractoros_entry_lines',
  'contractoros_accounts',
  'contractoros_bill_links',
  'contractoros_books_meta',
  'contractoros_ledger_entries',
  'contractoros_ledger_meta',
  'contractoros_ledger_attachments',
  'contractoros_ledger_attachment_meta',
  'contractoros_entry_documents',
  'contractoros_entry_items',
  'contractoros_parties',
  'contractoros_cost_codes',
  'contractoros_tax_settings',
  'contractoros_settings',
  'contractoros_commitments',
  'contractoros_stock_items',
  'contractoros_stock_movements',
  // ── File vault (metadata; the bytes are real files on this computer) ───
  'contractoros_vault_documents',
  'contractoros_vault_folders',
  // ── Notifications (the inbox is derived; preferences are user intent) ──
  'contractoros_notifications',
  'contractoros_notification_prefs',
  'contractoros_notification_state',
  // ── Company identity printed on this job's documents ───────────────────
  'contractoros_company',
] as const;

export function normalizeProjectId(id: string): string {
  return String(id || '').trim().toUpperCase();
}

export function scopedKey(base: string, projectId: string): string {
  return `${base}${SCOPE_SEPARATOR}${normalizeProjectId(projectId)}`;
}

export function getActiveProject(): string {
  try {
    const raw = localStorage.getItem(ACTIVE_PROJECT_KEY);
    if (raw && raw.trim()) return normalizeProjectId(raw);
  } catch {
    /* storage blocked — fall through to the original job */
  }
  return DEFAULT_PROJECT_ID;
}

export function setActiveProject(id: string) {
  const projectId = normalizeProjectId(id) || DEFAULT_PROJECT_ID;
  try {
    localStorage.setItem(ACTIVE_PROJECT_KEY, projectId);
  } catch {
    /* storage blocked — the in-memory selection still changes via the event */
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(PROJECT_CHANGED_EVENT, { detail: { projectId } }));
  }
}

/**
 * The job that owns unscoped (pre-scoping) data. Recorded once, at migration;
 * until then the original job is assumed, matching older builds and tests.
 */
export function scopeOwner(): string {
  try {
    const raw = localStorage.getItem(SCOPE_OWNER_KEY);
    if (raw && raw.trim()) return normalizeProjectId(raw);
  } catch {
    /* storage blocked */
  }
  return DEFAULT_PROJECT_ID;
}

/**
 * The storage key a project's data actually lives under: its own scoped key,
 * or — for the scope owner only — the pre-scope key while that is all it has.
 */
export function keyFor(base: string, projectId: string = getActiveProject()): string {
  const project = normalizeProjectId(projectId);
  const scoped = scopedKey(base, project);
  try {
    if (localStorage.getItem(scoped) !== null) return scoped;
    if (project === scopeOwner() && localStorage.getItem(base) !== null) return base;
  } catch {
    /* storage blocked */
  }
  return scoped;
}

export function readScoped<T>(base: string, fallback: T, projectId: string = getActiveProject()): T {
  try {
    const raw = localStorage.getItem(keyFor(base, projectId));
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeScoped(base: string, value: unknown, projectId: string = getActiveProject()) {
  try {
    localStorage.setItem(keyFor(base, projectId), JSON.stringify(value));
  } catch {
    /* quota/blocked storage — the caller keeps the in-memory value */
  }
}

/**
 * Like `writeScoped`, but a failed write is raised to the caller. The book
 * stores use this because their saves are atomic: if a line table cannot be
 * written, the entry must be rolled back instead of reporting success.
 */
export function writeScopedStrict(base: string, value: unknown, projectId: string = getActiveProject()) {
  localStorage.setItem(keyFor(base, projectId), JSON.stringify(value));
}

/** True when any project already holds a scoped copy of `base`. */
function hasScopedCopy(base: string): boolean {
  try {
    const prefix = `${base}${SCOPE_SEPARATOR}`;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) return true;
    }
  } catch {
    /* storage blocked */
  }
  return false;
}

/**
 * Adopt pre-scope data into the open job, once.
 * Non-destructive: originals stay in place as the backup, and a manifest of
 * what was copied is recorded before anything is written. The open job becomes
 * the scope owner, so its legacy keys remain readable while every other job
 * starts from an empty, fully separate set.
 */
export function migrateProjectScope(): { migrated: number } {
  try {
    const owner = getActiveProject();
    // Record who owns the unscoped keys even for installs that already ran the
    // first migration under an older build, which had no owner marker.
    if (!localStorage.getItem(SCOPE_OWNER_KEY)) {
      localStorage.setItem(SCOPE_OWNER_KEY, owner);
    }
    if (localStorage.getItem(SCOPE_MIGRATED_KEY)) return { migrated: 0 };

    const copied: string[] = [];
    const pending: Array<[string, string]> = [];
    for (const base of SCOPED_BASES) {
      const raw = localStorage.getItem(base);
      if (raw === null) continue;
      // Any scoped copy — this job's or another job's — means the base was
      // already adopted (a newer build migrated first, or this job already
      // holds data): copying it again would duplicate records across jobs.
      if (hasScopedCopy(base)) continue;
      pending.push([scopedKey(base, owner), raw]);
      copied.push(base);
    }
    if (pending.length > 0) {
      localStorage.setItem(
        SCOPE_BACKUP_KEY,
        JSON.stringify({
          at: new Date().toISOString(),
          projectId: owner,
          sourceKeys: copied,
          note: 'Originals retained under their unscoped keys.',
        })
      );
      for (const [target, raw] of pending) localStorage.setItem(target, raw);
    }
    localStorage.setItem(SCOPE_MIGRATED_KEY, '1');
    return { migrated: pending.length };
  } catch {
    return { migrated: 0 };
  }
}

/** React: the active project id, re-rendering on every switch. */
export function useActiveProject(): string {
  const [projectId, setProjectId] = useState<string>(() => getActiveProject());
  useEffect(() => {
    const sync = () => setProjectId(getActiveProject());
    window.addEventListener(PROJECT_CHANGED_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(PROJECT_CHANGED_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return projectId;
}

/**
 * `useLocalStorage` for project-scoped data. Switching projects reloads from
 * the new project's keys without ever writing the previous project's value
 * into them: the rendered value is derived from the key it was read under, and
 * a write always targets the current project.
 */
export function useScopedLocalStorage<T>(
  base: string,
  initialValue: T
): [T, (value: T | ((prev: T) => T)) => void] {
  const projectId = useActiveProject();
  const key = keyFor(base, projectId);
  const [entry, setEntry] = useState<{ key: string; value: T }>(() => ({
    key,
    value: readScoped<T>(base, initialValue, projectId),
  }));

  const value = entry.key === key ? entry.value : readScoped<T>(base, initialValue, projectId);

  const setValue = useCallback(
    (next: T | ((prev: T) => T)) => {
      setEntry((prev) => {
        const current = prev.key === key ? prev.value : readScoped<T>(base, initialValue, projectId);
        const resolved = next instanceof Function ? (next as (p: T) => T)(current) : next;
        writeScoped(base, resolved, projectId);
        return { key, value: resolved };
      });
    },
    [base, key, projectId, initialValue]
  );

  return [value, setValue];
}
