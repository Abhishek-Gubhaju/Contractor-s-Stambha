// ============================================================================
// DsrAttachments — the "Photos & files" section of the Daily Site Report.
//
// Add any file (PDF, Word, Excel, an AutoCAD drawing, a site photograph) and it
// is written to the File Vault immediately, into
// `Daily Site Reports / YYYY-MM / YYYY-MM-DD`, then linked to the report.
// Uploading immediately is deliberate: a draft that is never saved must not
// lose a photograph that took ten minutes to take. The trade-off is honest —
// the file stays in the Vault, where it can be opened, moved or deleted.
//
// Removing a row here only removes the LINK. No byte is deleted from the
// editor; that is the Vault page's Trash, with its own confirmation and undo.
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  ExternalLink,
  Loader2,
  Paperclip,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { activeUser } from '../../services/auth/authService';
import { confirmDialog } from '../../components/ui/DialogHost';
import { formatBytes } from '../../services/staffService';
import {
  MAX_DSR_ATTACHMENTS,
  type DsrAttachment,
  type DsrReport,
} from '../../services/dsrService';
import {
  cancelDsrUpload,
  existingDsrFolderLabel,
  uploadDsrAttachments,
} from '../../services/dsrAttachments';
import type { VaultContext, VaultStorage } from '../../services/vault/storageTypes';
import { getVaultStorage } from '../../services/vault/vaultStorage';
import { kindOf, listDocuments } from '../../services/vault/vaultService';
import type { VaultDocument } from '../../types/vault';
import { cn } from '../../utils';
import { KIND_LABELS, KIND_TONES, VaultFileIcon } from '../vault/FileIcon';
import { VaultThumb } from '../vault/VaultThumb';

interface DsrAttachmentsProps {
  report: DsrReport;
  locked: boolean;
  /** Injected by tests; the app resolves the real adapter. */
  storage?: VaultStorage;
  onAttach: (rows: DsrAttachment[]) => void;
  onDetach: (id: string) => void;
  onOpenInVault: (docId: string) => void;
}

interface QueueRow {
  key: string;
  name: string;
  percent: number;
  status: 'uploading' | 'done' | 'error' | 'cancelled';
  message?: string;
  file: File;
}

function when(value: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
}

export function DsrAttachments({
  report,
  locked,
  storage,
  onAttach,
  onDetach,
  onOpenInVault,
}: DsrAttachmentsProps) {
  const vault = storage ?? getVaultStorage();
  const attachments = report.attachments ?? [];
  const userId = activeUser()?.id ?? null;
  // The report's own job, never whatever job is open now: a stale editor must
  // not file these photographs under another contract.
  const ctx = useMemo<VaultContext | null>(
    () => (userId && report.project_id ? { userId, projectId: report.project_id } : null),
    [report.project_id, userId]
  );

  const [docs, setDocs] = useState<Map<string, VaultDocument>>(() => new Map());
  const [folderLabel, setFolderLabel] = useState(() => existingDsrFolderLabel(report.date, report.project_id));
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [error, setError] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const controllers = useRef(new Map<string, AbortController>());
  const inflight = useRef(0);
  const mounted = useRef(true);

  const refreshDocs = useCallback(() => {
    const rows = listDocuments(report.project_id);
    setDocs(new Map(rows.map((doc) => [doc.id, doc])));
    // Read-only: reflect a renamed tree without creating one just by opening.
    setFolderLabel(existingDsrFolderLabel(report.date, report.project_id));
  }, [report.date, report.project_id]);

  useEffect(() => {
    refreshDocs();
  }, [refreshDocs, attachments.length]);

  useEffect(() => {
    mounted.current = true;
    const running = controllers.current;
    return () => {
      mounted.current = false;
      running.forEach((controller) => controller.abort());
      running.clear();
    };
  }, []);

  const states = useMemo(() => {
    const out = new Map<string, 'ok' | 'trashed' | 'missing'>();
    for (const row of attachments) {
      const doc = docs.get(row.id);
      out.set(row.id, !doc ? 'missing' : doc.deletedAt ? 'trashed' : 'ok');
    }
    return out;
  }, [attachments, docs]);

  const patchQueue = (key: string, patch: Partial<QueueRow>) => {
    setQueue((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const uploadOne = useCallback(
    async (file: File) => {
      if (!ctx) {
        setError('Sign in before adding files to a report.');
        return;
      }
      const key = `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const controller = new AbortController();
      controllers.current.set(key, controller);
      setQueue((rows) => [
        ...rows,
        { key, name: file.name, percent: 0, status: 'uploading', file },
      ]);
      try {
        const result = await uploadDsrAttachments({
          files: [file],
          report,
          ctx,
          storage: vault,
          signal: controller.signal,
          onProgress: (percent) => patchQueue(key, { percent }),
        });
        const failure = result.failed[0];
        if (result.added.length > 0) onAttach(result.added);
        if (failure) {
          patchQueue(key, {
            status: failure.message === 'Cancelled.' ? 'cancelled' : 'error',
            message: failure.message,
          });
          if (failure.message !== 'Cancelled.') {
            setError(`Could not add “${file.name}”: ${failure.message}`);
          }
        } else {
          patchQueue(key, { status: 'done', percent: 100 });
        }
        refreshDocs();
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        patchQueue(key, { status: 'error', message });
        setError(message);
      } finally {
        controllers.current.delete(key);
        inflight.current = Math.max(0, inflight.current - 1);
      }
    },
    [ctx, onAttach, refreshDocs, report, vault]
  );

  const addFiles = useCallback(
    (picked: File[] | FileList | null) => {
      const list = Array.from(picked || []).filter(Boolean);
      if (list.length === 0) return;
      if (!ctx) {
        setError('Sign in before adding files to a report.');
        return;
      }
      if (locked) {
        setError('An approved report is locked — reopen it to add files.');
        return;
      }
      const total = attachments.length + inflight.current + list.length;
      if (total > MAX_DSR_ATTACHMENTS) {
        setError(
          `A report can link ${MAX_DSR_ATTACHMENTS} files. You have ${attachments.length} and picked ${list.length}.`
        );
        return;
      }
      setError('');
      inflight.current += list.length;
      for (const file of list) void uploadOne(file);
    },
    [attachments.length, ctx, locked, uploadOne]
  );

  const cancel = (row: QueueRow) => {
    cancelDsrUpload(controllers.current.get(row.key) ?? null);
    patchQueue(row.key, { status: 'cancelled', message: 'Cancelled.' });
  };

  const retry = (row: QueueRow) => {
    setQueue((rows) => rows.filter((item) => item.key !== row.key));
    inflight.current += 1;
    void uploadOne(row.file);
  };

  const detach = async (row: DsrAttachment) => {
    const ok = await confirmDialog({
      title: 'Remove from this report',
      message: `Remove “${row.name}” from ${report.reportNo || 'this report'}?\n\nThe file stays in the File Vault — nothing is deleted.`,
      confirmLabel: 'Remove link',
    });
    if (!ok) return;
    onDetach(row.id);
  };

  const atCap = attachments.length >= MAX_DSR_ATTACHMENTS;
  const disabled = locked || !ctx;

  return (
    <section
      className="space-y-3"
      data-testid="dsr-attachments"
      aria-label="Photos and files"
      tabIndex={0}
      onPaste={(event) => {
        const files = Array.from(event.clipboardData?.files || []).filter((file) =>
          String(file.type || '').startsWith('image/')
        );
        if (files.length === 0) return;
        event.preventDefault();
        addFiles(files);
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs text-gray-500">
            Site photographs, challans, test reports and drawings. Files are stored in the File Vault,
            under <span className="font-medium">{folderLabel}</span>.
          </p>
          <p className="text-[11px] text-gray-400">
            {attachments.length} of {MAX_DSR_ATTACHMENTS} files linked
            {locked ? ' · approved report — read only' : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => photoInput.current?.click()}
            disabled={disabled || atCap}
            data-testid="dsr-attach-photo"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 rounded px-2 py-1 disabled:opacity-40"
          >
            <Camera className="w-3.5 h-3.5" /> Take photo
          </button>
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={disabled || atCap}
            data-testid="dsr-attach-add"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded px-2 py-1 disabled:opacity-40"
          >
            <Upload className="w-3.5 h-3.5" /> Add files
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            data-testid="dsr-attach-input"
            disabled={disabled || atCap}
            onChange={(event) => {
              addFiles(event.target.files);
              event.target.value = '';
            }}
          />
          <input
            ref={photoInput}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            className="hidden"
            data-testid="dsr-attach-photo-input"
            disabled={disabled || atCap}
            onChange={(event) => {
              addFiles(event.target.files);
              event.target.value = '';
            }}
          />
        </div>
      </div>

      {vault.mode !== 'desktop' && (
        <div
          className="flex items-start gap-2 rounded-lg border border-gray-200 border-l-2 border-l-amber-600 bg-white px-3 py-2 text-[11px] text-amber-900"
          data-testid="dsr-attach-mode"
        >
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {vault.mode === 'browser'
              ? 'This browser build keeps the files in this browser only — they are not part of a ZIP backup. Use the desktop app for site records.'
              : 'Files are held for this session only because neither the desktop app nor browser storage is available.'}
          </span>
        </div>
      )}

      {error && (
        <div
          className="rounded-lg border border-gray-200 border-l-2 border-l-red-600 bg-white px-3 py-2 text-xs text-rose-700"
          role="alert"
          data-testid="dsr-attach-error"
        >
          {error}
        </div>
      )}

      <div
        onDragOver={(event) => {
          if (disabled) return;
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          if (disabled) return;
          addFiles(event.dataTransfer?.files ?? null);
        }}
        className={cn(
          'rounded-lg border border-dashed p-2 transition-colors',
          dragActive
            ? 'border-blue-400 bg-blue-50/70'
            : 'border-gray-200 bg-gray-50/40 dark:border-gray-700 dark:bg-gray-800/30'
        )}
        data-testid="dsr-attach-drop"
      >
        {queue.length > 0 && (
          <ul className="mb-2 space-y-1.5" aria-live="polite">
            {queue.map((row) => (
              <li key={row.key} className="text-[11px]" data-testid={`dsr-attach-queue-${row.status}`}>
                <div className="flex items-center gap-2">
                  {row.status === 'uploading' ? (
                    <Loader2 className="w-3 h-3 animate-spin text-blue-600" aria-hidden="true" />
                  ) : row.status === 'done' ? (
                    <Paperclip className="w-3 h-3 text-emerald-600" aria-hidden="true" />
                  ) : (
                    <AlertTriangle className="w-3 h-3 text-rose-500" aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-200">
                    {row.name}
                  </span>
                  <span className="tabular-nums text-gray-500">
                    {row.status === 'uploading'
                      ? `${row.percent}%`
                      : row.status === 'done'
                        ? 'Added'
                        : row.status === 'error'
                          ? 'Failed'
                          : 'Cancelled'}
                  </span>
                  {row.status === 'uploading' && (
                    <button
                      type="button"
                      onClick={() => cancel(row)}
                      aria-label={`Cancel ${row.name}`}
                      className="p-1 rounded text-gray-400 hover:text-rose-600"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                  {(row.status === 'error' || row.status === 'cancelled') && (
                    <button
                      type="button"
                      onClick={() => retry(row)}
                      aria-label={`Retry ${row.name}`}
                      className="p-1 rounded text-gray-400 hover:text-blue-600"
                    >
                      <RotateCcw className="w-3 h-3" />
                    </button>
                  )}
                </div>
                {row.status === 'uploading' && (
                  <div className="mt-1 h-1 rounded-full bg-gray-200 overflow-hidden">
                    <div className="h-full bg-blue-600" style={{ width: `${row.percent}%` }} />
                  </div>
                )}
                {row.status === 'error' && row.message && (
                  <p className="mt-0.5 text-rose-600">{row.message}</p>
                )}
              </li>
            ))}
          </ul>
        )}

        <ul className="divide-y divide-gray-100 dark:divide-gray-800" data-testid="dsr-attach-list">
          {attachments.map((row) => {
            const doc = docs.get(row.id);
            const state = states.get(row.id) ?? 'missing';
            const kind = doc?.kind ?? kindOf(row.ext || row.name);
            return (
              <li key={row.id} className="flex items-center gap-2 py-1.5">
                {doc && ctx ? (
                  <VaultThumb doc={doc} ctx={ctx} storage={vault} />
                ) : (
                  <span
                    className={cn(
                      'w-9 h-9 rounded flex items-center justify-center shrink-0',
                      KIND_TONES[kind]
                    )}
                  >
                    <VaultFileIcon kind={kind} className="w-4 h-4" />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-gray-800 dark:text-gray-100 truncate" title={row.name}>
                    {row.name}
                  </p>
                  <p className="text-[11px] text-gray-500">
                    {KIND_LABELS[kind] || 'File'}
                    {row.sizeBytes > 0 ? ` · ${formatBytes(row.sizeBytes)}` : ''}
                    {` · ${when(row.addedAt)}`}
                  </p>
                </div>
                {state === 'missing' && (
                  <span
                    className="text-[10px] rounded-full bg-amber-100 text-amber-800 px-1.5 py-0.5"
                    title="The vault no longer lists this file"
                  >
                    Not in Vault
                  </span>
                )}
                {state === 'trashed' && (
                  <span
                    className="text-[10px] rounded-full bg-rose-100 text-rose-700 px-1.5 py-0.5"
                    title="This file is in the Vault's Trash"
                  >
                    In Trash
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => onOpenInVault(row.id)}
                  data-testid={`dsr-attach-open-${row.id}`}
                  className="p-1 rounded text-gray-400 hover:text-blue-600"
                  title="Open in File Vault"
                  aria-label={`Open ${row.name} in the File Vault`}
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </button>
                {!locked && (
                  <button
                    type="button"
                    onClick={() => void detach(row)}
                    data-testid={`dsr-attach-remove-${row.id}`}
                    className="p-1 rounded text-gray-400 hover:text-rose-600"
                    title="Remove from this report (the file stays in the Vault)"
                    aria-label={`Remove ${row.name} from this report`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </li>
            );
          })}
          {attachments.length === 0 && (
            <li className="py-4 text-center text-[11px] text-gray-400">
              No files yet — add a site photograph, a challan or a test report.
            </li>
          )}
        </ul>
      </div>

      <p className="text-[11px] text-gray-400">
        Removing a file here only unlinks it; the file stays in the File Vault.
      </p>
    </section>
  );
}

export default DsrAttachments;
