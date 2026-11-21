import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  Download,
  ExternalLink,
  FolderOpen,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import type { VaultDocument, VaultFolder } from '../../types/vault';
import type { VaultContext, VaultStorage } from '../../services/vault/storageTypes';
import {
  documentFolderLabel,
  isOpenSupported,
  normalizeTags,
  readPreview,
  type VaultPreview,
} from '../../services/vault/vaultService';
import { formatBytes } from '../../services/staffService';
import { cn } from '../../utils';
import { KIND_LABELS, KIND_TONES, VaultFileIcon } from './FileIcon';

interface Props {
  doc: VaultDocument;
  folders: VaultFolder[];
  ctx: VaultContext;
  storage: VaultStorage;
  onClose: () => void;
  onOpen: () => void;
  onReveal: () => void;
  onSaveCopy: () => void;
  onRename: () => void;
  onMove: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onForget: () => void;
  onPatch: (patch: { tags?: string[]; notes?: string }) => void;
}

function when(value: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

export function VaultDetails({
  doc,
  folders,
  ctx,
  storage,
  onClose,
  onOpen,
  onReveal,
  onSaveCopy,
  onRename,
  onMove,
  onDelete,
  onRestore,
  onForget,
  onPatch,
}: Props) {
  const [preview, setPreview] = useState<VaultPreview | null>(null);
  const [tagText, setTagText] = useState(doc.tags.join(', '));
  const [notes, setNotes] = useState(doc.notes);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    readPreview(ctx, doc, storage)
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setPreview({
            status: 'none',
            reason: error instanceof Error ? error.message : 'That file could not be read.',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [ctx, doc, storage]);

  const missing = preview?.status === 'missing';
  const trashed = Boolean(doc.deletedAt);
  const openable = isOpenSupported(doc.ext);
  const tone = KIND_TONES[doc.kind];

  const actionButton =
    'inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

  return (
    <div className="flex flex-col h-full" data-testid="vault-details" aria-label={`Details for ${doc.name}`}>
      <div className="flex items-start gap-3 p-4 border-b border-gray-200 dark:border-gray-800">
        <div className={cn('w-11 h-11 rounded-lg flex items-center justify-center shrink-0', tone)}>
          <VaultFileIcon kind={doc.kind} className="w-6 h-6" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 break-words">{doc.name}</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {KIND_LABELS[doc.kind]} · {formatBytes(doc.sizeBytes)}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="p-4">
          {!preview && (
            <div className="h-40 rounded-lg border border-dashed border-gray-200 dark:border-gray-700 flex items-center justify-center text-sm text-gray-500">
              Reading the file…
            </div>
          )}

          {preview?.status === 'missing' && (
            <div className="rounded-lg border border-gray-200 border-l-2 border-l-amber-600 bg-white dark:border-amber-900/60 dark:bg-amber-950/30 p-4">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5" aria-hidden="true" />
                <div>
                  <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                    Missing on this computer
                  </p>
                  <p className="text-xs text-amber-800 dark:text-amber-300 mt-1">
                    The index still lists this file, but its bytes are not in the vault folder. Restore a
                    backup that includes the vault, or remove the row.
                  </p>
                  <button
                    type="button"
                    onClick={onForget}
                    data-testid="vault-forget"
                    className="mt-2 text-xs font-medium text-amber-900 underline underline-offset-2 dark:text-amber-200"
                  >
                    Remove from list
                  </button>
                </div>
              </div>
            </div>
          )}

          {preview?.status === 'ready' && preview.kind === 'image' && (
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 p-2">
              <img
                src={preview.dataUrl}
                alt={doc.name}
                className="max-h-72 w-full object-contain rounded"
              />
            </div>
          )}

          {preview?.status === 'ready' && preview.kind === 'text' && (
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
              <pre className="max-h-64 overflow-auto p-3 text-[11px] leading-relaxed whitespace-pre-wrap break-words font-mono text-gray-700 dark:text-gray-300">
                {preview.text}
              </pre>
              {preview.truncated && (
                <p className="px-3 py-1.5 text-[10px] text-gray-500 border-t border-gray-200 dark:border-gray-700">
                  Showing the first 64 KB.
                </p>
              )}
            </div>
          )}

          {preview?.status === 'none' && (
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 p-4 text-center">
              <div className={cn('mx-auto w-12 h-12 rounded-xl flex items-center justify-center', tone)}>
                <VaultFileIcon kind={doc.kind} className="w-6 h-6" />
              </div>
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                {preview.reason || 'This format opens in its own app.'}
              </p>
            </div>
          )}
        </div>

        {trashed && (
          <div className="mx-4 mb-4 rounded-lg border border-gray-200 border-l-2 border-l-red-600 bg-white dark:border-rose-900/60 dark:bg-rose-950/30 px-3 py-2">
            <p className="text-xs text-rose-800 dark:text-rose-200">
              This file is in Trash. It still exists on this computer until the trash is emptied.
            </p>
            <button
              type="button"
              onClick={onRestore}
              data-testid="vault-restore"
              className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-rose-900 dark:text-rose-100 underline underline-offset-2"
            >
              <RotateCcw className="w-3.5 h-3.5" /> Restore to {documentFolderLabel(folders, doc)}
            </button>
          </div>
        )}

        <div className="px-4 pb-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onOpen}
            disabled={missing || !openable}
            data-testid="vault-open"
            title={openable ? 'Open with the default app' : 'This type has no safe viewer here'}
            className={cn(actionButton, 'border-gray-200 bg-white text-gray-800 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:hover:bg-gray-800')}
          >
            <ExternalLink className="w-4 h-4" /> Open
          </button>
          <button
            type="button"
            onClick={onReveal}
            disabled={missing || !storage.revealNative}
            data-testid="vault-reveal"
            className={cn(actionButton, 'border-gray-200 bg-white text-gray-800 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:hover:bg-gray-800')}
          >
            <FolderOpen className="w-4 h-4" /> Reveal
          </button>
          <button
            type="button"
            onClick={onSaveCopy}
            disabled={missing || !storage.exportCopy}
            data-testid="vault-save-copy"
            className={cn(actionButton, 'border-gray-200 bg-white text-gray-800 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:hover:bg-gray-800')}
          >
            <Download className="w-4 h-4" /> Save a copy
          </button>
          <button
            type="button"
            onClick={onRename}
            data-testid="vault-rename"
            className={cn(actionButton, 'border-gray-200 bg-white text-gray-800 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:hover:bg-gray-800')}
          >
            Rename
          </button>
          <button
            type="button"
            onClick={onMove}
            disabled={trashed}
            data-testid="vault-move"
            className={cn(actionButton, 'border-gray-200 bg-white text-gray-800 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:hover:bg-gray-800')}
          >
            <ChevronDown className="w-4 h-4" /> Move
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={trashed}
            data-testid="vault-delete"
            className={cn(actionButton, 'border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-200')}
          >
            <Trash2 className="w-4 h-4" /> Delete
          </button>
        </div>

        <div className="px-4 pb-6 space-y-3">
          <label className="block">
            <span className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
              Tags (comma separated)
            </span>
            <input
              value={tagText}
              onChange={(event) => setTagText(event.target.value)}
              onBlur={() => onPatch({ tags: normalizeTags(tagText) })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
                if (event.key === 'Escape') setTagText(doc.tags.join(', '));
              }}
              data-testid="vault-tags"
              className="w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100"
              placeholder="approved, revision-b"
            />
          </label>

          <label className="block">
            <span className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Notes</span>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              onBlur={() => onPatch({ notes })}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setNotes(doc.notes);
              }}
              rows={3}
              maxLength={2000}
              data-testid="vault-notes"
              className="w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100"
              placeholder="What this document is for…"
            />
          </label>

          <dl className="rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-800 text-xs">
            {[
              ['Folder', documentFolderLabel(folders, doc)],
              ['Type', `${KIND_LABELS[doc.kind]} (.${doc.ext})`],
              ['Size', formatBytes(doc.sizeBytes)],
              ['Added', when(doc.createdAt)],
              ['Modified', when(doc.updatedAt)],
              ['Fingerprint', doc.checksum ? doc.checksum.slice(0, 12) : '—'],
            ].map(([label, value]) => (
              <div key={label} className="flex gap-3 px-3 py-1.5">
                <dt className="w-20 shrink-0 text-gray-500 dark:text-gray-400">{label}</dt>
                <dd className="min-w-0 flex-1 text-gray-800 dark:text-gray-200 break-words">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-[11px] text-gray-400 dark:text-gray-500">
            Fingerprint identifies these exact bytes — it catches a damaged or swapped file.
          </p>
        </div>
      </div>
    </div>
  );
}
