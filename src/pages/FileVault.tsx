// ============================================================================
// File Vault — the job's container for every document.
//
// One page, one place: upload (or drop) any file, file it in folders, search
// and filter, preview what can be previewed honestly, open the rest in its own
// application, and keep deletions reversible through Trash.
//
// The bytes live outside localStorage (real files on the desktop, IndexedDB in
// a browser). The page therefore talks to the storage adapter for everything
// file-shaped and only sends metadata through vaultService.
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  FolderPlus,
  HardDrive,
  Loader2,
  SearchX,
  Trash2,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import type { VaultDocument, VaultFolder, VaultKind, VaultSort } from '../types/vault';
import { activeUser } from '../services/auth/authService';
import { useActiveProject } from '../services/projectScope';
import { useDebounce } from '../hooks';
import { confirmDialog, notify } from '../components/ui/DialogHost';
import { getVaultStorage } from '../services/vault/vaultStorage';
import type { VaultContext } from '../services/vault/storageTypes';
import {
  createFolder,
  deleteFolder,
  documentById,
  emptyTrash,
  ensureFolderPath,
  folderCounts,
  folderLabel,
  isOpenSupported,
  listDocuments,
  listFolders,
  purgeDocumentRecord,
  queryDocuments,
  renameFolder,
  restoreDocument,
  tagList,
  trashDocument,
  updateDocument,
  uploadDocument,
  vaultSummary,
  type VaultDocumentPatch,
} from '../services/vault/vaultService';
import { formatBytes } from '../services/staffService';
import { cn } from '../utils';
import { FolderTree } from './vault/FolderTree';
import { VaultToolbar } from './vault/VaultToolbar';
import { VaultDetails } from './vault/VaultDetails';
import { MoveModal, NameModal } from './vault/VaultModals';
import { KIND_LABELS, KIND_TONES, VaultFileIcon } from './vault/FileIcon';
import { VaultThumb } from './vault/VaultThumb';
import { takeVaultFocus } from '../services/dsrAttachments';

type FolderSelection = 'all' | 'root' | string;

interface QueueRow {
  id: string;
  name: string;
  size: number;
  percent: number;
  status: 'uploading' | 'done' | 'error' | 'cancelled';
  error?: string;
}

interface DroppedFile {
  file: File;
  path: string[];
}

function readEntry(entry: any, path: string[]): Promise<DroppedFile[]> {
  return new Promise((resolve) => {
    if (!entry) {
      resolve([]);
      return;
    }
    if (entry.isFile) {
      entry.file(
        (file: File) => resolve([{ file, path }]),
        () => resolve([])
      );
      return;
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      const collected: any[] = [];
      const readBatch = () => {
        reader.readEntries(
          (rows: any[]) => {
            if (!rows.length) {
              Promise.all(collected.map((row) => readEntry(row, [...path, entry.name])))
                .then((groups) => resolve(groups.flat()))
                .catch(() => resolve([]));
              return;
            }
            collected.push(...rows);
            readBatch();
          },
          () => resolve([])
        );
      };
      readBatch();
      return;
    }
    resolve([]);
  });
}

async function droppedFiles(dataTransfer: DataTransfer): Promise<DroppedFile[]> {
  const items = Array.from(dataTransfer.items || []);
  const entries = items
    .map((item) => {
      const withEntry = item as DataTransferItem & { webkitGetAsEntry?: () => any };
      try {
        return withEntry.webkitGetAsEntry?.() ?? null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (entries.length) {
    const groups = await Promise.all(entries.map((entry) => readEntry(entry, [])));
    const rows = groups.flat();
    if (rows.length) return rows;
  }
  return Array.from(dataTransfer.files || []).map((file) => ({ file, path: [] }));
}

export default function FileVaultPage() {
  const projectId = useActiveProject();
  const storage = getVaultStorage();
  const userId = activeUser()?.id ?? null;
  const ctx = useMemo<VaultContext | null>(
    () => (userId ? { userId, projectId } : null),
    [projectId, userId]
  );

  const [folders, setFolders] = useState<VaultFolder[]>([]);
  const [docs, setDocs] = useState<VaultDocument[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<FolderSelection>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<VaultKind | 'all'>('all');
  const [tag, setTag] = useState<string | null>(null);
  const [sort, setSort] = useState<VaultSort>('updated');
  const [view, setView] = useState<'list' | 'grid'>('list');
  const [showTrash, setShowTrash] = useState(false);
  const [page, setPage] = useState(1);
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [undoId, setUndoId] = useState<string | null>(null);
  const [nameModal, setNameModal] = useState<
    { mode: 'create' | 'rename'; folder?: VaultFolder } | null
  >(null);
  const [nameError, setNameError] = useState('');
  const [renameDoc, setRenameDoc] = useState<VaultDocument | null>(null);
  const [moveDoc, setMoveDoc] = useState<VaultDocument | null>(null);
  const [folderPath, setFolderPath] = useState<string | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);
  const controllers = useRef(new Map<string, AbortController>());
  const debouncedQuery = useDebounce(query, 150);

  const refresh = useCallback(() => {
    setFolders(listFolders(projectId));
    setDocs(listDocuments(projectId));
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    setLoading(true);
    refresh();
  }, [refresh]);

  // A DSR (or another page) can ask the Vault to open on a file or folder.
  // The instruction is one-shot and ignored when it is stale or from another job.
  useEffect(() => {
    const focus = takeVaultFocus(projectId);
    if (!focus) return;
    const doc = focus.docId ? documentById(focus.docId, projectId) : null;
    const folders = listFolders(projectId);
    const folder = focus.folderId && folders.some((row) => row.id === focus.folderId)
      ? focus.folderId
      : doc?.folderId ?? null;
    if (folder) setSelectedFolder(folder);
    else if (doc) setSelectedFolder('root');
    if (focus.docId) {
      if (doc) setSelectedId(doc.id);
      else notify('That file is no longer in the File Vault.', 'error');
    }
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    if (!ctx || !storage.folderPath) {
      setFolderPath(null);
      return;
    }
    storage
      .folderPath(ctx)
      .then((value) => {
        if (!cancelled) setFolderPath(value);
      })
      .catch(() => {
        if (!cancelled) setFolderPath(null);
      });
    return () => {
      cancelled = true;
    };
  }, [ctx, storage]);

  useEffect(() => {
    setPage(1);
  }, [debouncedQuery, kind, tag, sort, selectedFolder, showTrash]);

  useEffect(() => {
    if (!undoId) return;
    const timer = window.setTimeout(() => setUndoId(null), 8000);
    return () => window.clearTimeout(timer);
  }, [undoId]);

  useEffect(() => {
    return () => {
      controllers.current.forEach((controller) => controller.abort());
      controllers.current.clear();
    };
  }, []);

  const folderFilter: string | null | undefined =
    selectedFolder === 'all' ? undefined : selectedFolder === 'root' ? null : selectedFolder;

  const result = queryDocuments(
    docs,
    {
      query: debouncedQuery,
      kind,
      folderId: folderFilter,
      tag,
      includeTrash: showTrash,
      sort,
      page,
    },
    folders
  );

  const summary = vaultSummary(docs);
  const counts = folderCounts(docs);
  const tags = tagList(docs);
  const trashCount = docs.filter((doc) => doc.deletedAt).length;
  // Derive from the loaded rows so a progress tick cannot hand VaultDetails a
  // new object and restart its preview read.
  const selectedDoc = useMemo(
    () => (selectedId ? docs.find((doc) => doc.id === selectedId) ?? null : null),
    [docs, selectedId]
  );
  const baseFolder = folderFilter === undefined ? null : folderFilter;
  const hasFilters = Boolean(debouncedQuery) || kind !== 'all' || Boolean(tag);

  const patchQueue = (id: string, patch: Partial<QueueRow>) => {
    setQueue((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const uploadOne = useCallback(
    async (file: File, folderId: string | null) => {
      if (!ctx) {
        notify('Sign in before adding files to the vault.', 'error');
        return;
      }
      const rowId = `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const controller = new AbortController();
      controllers.current.set(rowId, controller);
      setQueue((rows) => [
        ...rows,
        { id: rowId, name: file.name, size: file.size, percent: 0, status: 'uploading' },
      ]);
      try {
        const result = await uploadDocument({
          file,
          ctx,
          folderId,
          storage,
          signal: controller.signal,
          onProgress: (percent) => patchQueue(rowId, { percent }),
        });
        patchQueue(rowId, { percent: 100, status: 'done' });
        if (result.duplicate) notify(`“${result.document.name}” is already in this folder.`);
        refresh();
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError';
        const message = error instanceof Error ? error.message : String(error);
        patchQueue(rowId, { status: aborted ? 'cancelled' : 'error', error: message });
        if (!aborted) notify(`Could not add “${file.name}”: ${message}`, 'error');
      } finally {
        controllers.current.delete(rowId);
      }
    },
    [ctx, refresh, storage]
  );

  const uploadMany = useCallback(
    async (rows: Array<{ file: File; folderId: string | null }>) => {
      if (!ctx) {
        notify('Sign in before adding files to the vault.', 'error');
        return;
      }
      for (const row of rows) {
        await uploadOne(row.file, row.folderId);
      }
    },
    [ctx, uploadOne]
  );

  const handlePicked = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    void uploadMany(Array.from(files).map((file) => ({ file, folderId: baseFolder })));
  };

  const handleDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    setDragActive(false);
    if (!ctx) {
      notify('Sign in before adding files to the vault.', 'error');
      return;
    }
    const rows = await droppedFiles(event.dataTransfer);
    if (!rows.length) return;
    const prepared: Array<{ file: File; folderId: string | null }> = [];
    for (const row of rows) {
      const parent = row.path.length
        ? ensureFolderPath(row.path, baseFolder, projectId)
        : baseFolder;
      prepared.push({ file: row.file, folderId: parent });
    }
    refresh();
    await uploadMany(prepared);
  };

  const handleDropOnFolder = (folderId: string | null, files: File[]) => {
    void uploadMany(files.map((file) => ({ file, folderId })));
  };

  const openDoc = async (doc: VaultDocument) => {
    if (!ctx) return;
    if (!isOpenSupported(doc.ext)) {
      notify('This file type has no safe viewer here. Reveal it and open it from the folder.', 'error');
      return;
    }
    try {
      if (!storage.openNative) {
        notify('Opening a file needs the desktop app.', 'error');
        return;
      }
      await storage.openNative(ctx, { docId: doc.id, ext: doc.ext });
    } catch (error) {
      notify(error instanceof Error ? error.message : 'That file could not be opened.', 'error');
    }
  };

  const revealDoc = async (doc: VaultDocument) => {
    if (!ctx || !storage.revealNative) return;
    try {
      await storage.revealNative(ctx, { docId: doc.id, ext: doc.ext });
    } catch (error) {
      notify(error instanceof Error ? error.message : 'That file could not be revealed.', 'error');
    }
  };

  const saveCopy = async (doc: VaultDocument) => {
    if (!ctx || !storage.exportCopy) return;
    try {
      const where = await storage.exportCopy(ctx, {
        docId: doc.id,
        ext: doc.ext,
        fileName: doc.name,
      });
      notify(`Saved a copy: ${where}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not save a copy.', 'error');
    }
  };

  const deleteDoc = async (doc: VaultDocument) => {
    const ok = await confirmDialog({
      title: 'Move to Trash',
      message: `Move “${doc.name}” to Trash?\n\nThe file stays on this computer until the trash is emptied.`,
      confirmLabel: 'Move to Trash',
    });
    if (!ok) return;
    try {
      trashDocument(doc.id, projectId);
      setSelectedId(null);
      setUndoId(doc.id);
      refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'That file could not be moved.', 'error');
    }
  };

  const undoDelete = () => {
    if (!undoId) return;
    try {
      restoreDocument(undoId, projectId);
      refresh();
      notify('Restored from Trash.');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'That file could not be restored.', 'error');
    } finally {
      setUndoId(null);
    }
  };

  const restoreDoc = (doc: VaultDocument) => {
    try {
      restoreDocument(doc.id, projectId);
      setSelectedId(null);
      refresh();
      notify(`Restored “${doc.name}”.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'That file could not be restored.', 'error');
    }
  };

  const emptyAllTrash = async () => {
    if (!ctx) return;
    const ok = await confirmDialog({
      title: 'Empty Trash',
      message: `Permanently delete ${trashCount} ${trashCount === 1 ? 'file' : 'files'}?\n\nThis removes the bytes from this computer and cannot be undone.`,
      confirmLabel: 'Delete permanently',
    });
    if (!ok) return;
    try {
      const removed = await emptyTrash(ctx, storage);
      setSelectedId(null);
      refresh();
      notify(`Permanently removed ${removed} ${removed === 1 ? 'file' : 'files'}.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'The trash could not be emptied.', 'error');
    }
  };

  const forgetDoc = async (doc: VaultDocument) => {
    const ok = await confirmDialog({
      title: 'Remove from list',
      message: `Remove “${doc.name}” from the vault index?\n\nThe file is already missing; this only clears the row.`,
      confirmLabel: 'Remove row',
    });
    if (!ok) return;
    try {
      purgeDocumentRecord(doc.id, projectId);
      setSelectedId(null);
      refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'The row could not be removed.', 'error');
    }
  };

  const patchDoc = (doc: VaultDocument, patch: VaultDocumentPatch) => {
    try {
      const updated = updateDocument(doc.id, patch, projectId);
      setDocs(listDocuments(projectId));
      void updated;
    } catch (error) {
      notify(error instanceof Error ? error.message : 'That change could not be saved.', 'error');
    }
  };

  const askDeleteFolder = async (folder: VaultFolder) => {
    if (folder.system) {
      notify(`${folder.name} is managed by Daily Site Reports — move its files instead.`, 'error');
      return;
    }
    const contained = docs.filter((doc) => !doc.deletedAt && doc.folderId === folder.id).length;
    const ok = await confirmDialog({
      title: `Delete folder “${folder.name}”`,
      message:
        contained > 0
          ? `This folder holds ${contained} ${contained === 1 ? 'file' : 'files'}. They will move to the parent folder — no file is deleted.`
          : 'The folder is empty. Subfolders move up one level; no file is deleted.',
      confirmLabel: 'Delete folder',
    });
    if (!ok) return;
    try {
      const removed = deleteFolder(folder.id, projectId);
      if (selectedFolder === folder.id) setSelectedFolder('all');
      refresh();
      notify(
        `Folder deleted${removed.documents ? ` — ${removed.documents} file(s) moved up` : ''}.`
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : 'The folder could not be deleted.', 'error');
    }
  };

  const submitName = (value: string) => {
    try {
      if (renameDoc) {
        updateDocument(renameDoc.id, { name: value }, projectId);
        setRenameDoc(null);
        setNameError('');
        refresh();
        return;
      }
      if (!nameModal) return;
      if (nameModal.mode === 'create') {
        const created = createFolder(value, baseFolder, projectId);
        setSelectedFolder(created.id);
      } else if (nameModal.folder) {
        renameFolder(nameModal.folder.id, value, projectId);
      }
      setNameModal(null);
      setNameError('');
      refresh();
    } catch (error) {
      setNameError(error instanceof Error ? error.message : 'That name could not be used.');
    }
  };

  const moveSelected = (folderId: string | null) => {
    if (!moveDoc) return;
    try {
      updateDocument(moveDoc.id, { folderId }, projectId);
      setMoveDoc(null);
      refresh();
      notify(`Moved to ${folderLabel(folders, folderId)}.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'That file could not be moved.', 'error');
    }
  };

  const clearFilters = () => {
    setQuery('');
    setKind('all');
    setTag(null);
    setSelectedFolder('all');
  };

  const uploadHint = folderFilter === undefined ? 'Unsorted' : folderLabel(folders, baseFolder);

  return (
    <div
      className="space-y-4"
      data-testid="vault-page"
      onDragOver={(event) => {
        event.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setDragActive(false);
      }}
      onDrop={(event) => void handleDrop(event)}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">File Vault</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Every drawing, contract, bill and photo for this job.
          </p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1">
              <HardDrive className="w-3.5 h-3.5" aria-hidden="true" />
              {summary.files} {summary.files === 1 ? 'file' : 'files'} · {formatBytes(summary.bytes)}
            </span>
            {folderPath && (
              <span className="font-mono text-[11px] text-gray-400 dark:text-gray-500 truncate max-w-full">
                {folderPath}
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setNameError('');
              setNameModal({ mode: 'create' });
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            <FolderPlus className="w-4 h-4" aria-hidden="true" /> New folder
          </button>
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            data-testid="vault-upload"
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            <Upload className="w-4 h-4" aria-hidden="true" /> Upload files
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            data-testid="vault-file-input"
            onChange={(event) => {
              handlePicked(event.target.files);
              event.target.value = '';
            }}
          />
        </div>
      </header>

      {!userId && (
        <div className="rounded-lg border border-gray-200 border-l-2 border-l-amber-600 bg-white px-3 py-2 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
          Sign in to open this job’s vault.
        </div>
      )}

      {storage.mode !== 'desktop' && (
        <div
          className="flex items-start gap-2 rounded-lg border border-gray-200 border-l-2 border-l-amber-600 bg-white px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200"
          data-testid="vault-mode-notice"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {storage.mode === 'browser'
              ? 'This browser build keeps vault files in this browser only. They are not part of a ZIP backup and are lost if browser data is cleared — use the desktop app for real documents.'
              : 'Files are held for this session only because neither the desktop app nor browser storage is available.'}
          </span>
        </div>
      )}

      {queue.length > 0 && (
        <section
          className="rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900"
          aria-live="polite"
          data-testid="vault-queue"
        >
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Adding files
            </h2>
            <button
              type="button"
              onClick={() => setQueue((rows) => rows.filter((row) => row.status === 'uploading'))}
              className="text-xs text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
            >
              Clear finished
            </button>
          </div>
          <ul className="space-y-2">
            {queue.map((row) => (
              <li key={row.id} className="text-xs" data-testid={`vault-queue-${row.status}`}>
                <div className="flex items-center gap-2">
                  {row.status === 'uploading' && (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600" aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-gray-800 dark:text-gray-200">{row.name}</span>
                  <span className="text-gray-500 dark:text-gray-400 tabular-nums">
                    {row.status === 'done'
                      ? 'Added'
                      : row.status === 'error'
                        ? 'Failed'
                        : row.status === 'cancelled'
                          ? 'Cancelled'
                          : `${row.percent}%`}
                  </span>
                  {row.status === 'uploading' && (
                    <button
                      type="button"
                      onClick={() => controllers.current.get(row.id)?.abort()}
                      aria-label={`Cancel ${row.name}`}
                      className="p-1 rounded text-gray-400 hover:text-rose-600"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <div className="mt-1 h-1 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
                  <div
                    className={cn(
                      'h-full transition-all',
                      row.status === 'error' ? 'bg-rose-500' : 'bg-blue-600'
                    )}
                    style={{ width: `${row.status === 'error' ? 100 : row.percent}%` }}
                  />
                </div>
                {row.error && <p className="mt-1 text-rose-600 dark:text-rose-400">{row.error}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {undoId && (
        <div
          className="flex items-center justify-between gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800/60"
          role="status"
        >
          <span className="text-gray-700 dark:text-gray-200">Moved to Trash.</span>
          <button
            type="button"
            onClick={undoDelete}
            data-testid="vault-undo"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-700 hover:underline dark:text-blue-300"
          >
            <Undo2 className="w-4 h-4" /> Undo
          </button>
        </div>
      )}

      <div className="flex gap-4 items-start">
        <FolderTree
          folders={folders}
          counts={counts}
          selected={selectedFolder}
          onSelect={(folder) => {
            setSelectedFolder(folder);
            setSelectedId(null);
          }}
          onCreate={() => {
            setNameError('');
            setNameModal({ mode: 'create' });
          }}
          onRename={(folder) => {
            setNameError('');
            setNameModal({ mode: 'rename', folder });
          }}
          onDelete={(folder) => void askDeleteFolder(folder)}
          onDropFiles={handleDropOnFolder}
        />

        <section className="min-w-0 flex-1 space-y-3">
          <VaultToolbar
            query={query}
            onQuery={setQuery}
            kind={kind}
            onKind={setKind}
            tag={tag}
            tags={tags}
            onTag={setTag}
            sort={sort}
            onSort={setSort}
            view={view}
            onView={setView}
            showTrash={showTrash}
            trashCount={trashCount}
            onToggleTrash={() => {
              setShowTrash((current) => !current);
              setSelectedId(null);
            }}
            onClear={clearFilters}
            hasFilters={hasFilters}
          />

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {folderFilter === undefined ? 'All files' : folderLabel(folders, baseFolder)}
              {' · '}
              {result.total} {result.total === 1 ? 'file' : 'files'}
              {hasFilters ? ' matching' : ''}
            </p>
            {showTrash && trashCount > 0 && (
              <button
                type="button"
                onClick={() => void emptyAllTrash()}
                data-testid="vault-empty-trash"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-rose-700 hover:underline dark:text-rose-300"
              >
                <Trash2 className="w-3.5 h-3.5" /> Empty trash ({trashCount})
              </button>
            )}
          </div>

          {dragActive && (
            <div className="rounded-xl border-2 border-dashed border-blue-400 bg-blue-50/70 px-4 py-6 text-center text-sm text-blue-700 dark:bg-blue-950/30 dark:text-blue-200">
              Drop to add to {uploadHint}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-20 text-sm text-gray-500">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading the vault…
            </div>
          ) : docs.length === 0 && !showTrash ? (
            <div
              className="rounded-xl border-2 border-dashed border-gray-300 dark:border-gray-700 px-6 py-12 text-center"
              data-testid="vault-empty"
            >
              <div className="mx-auto w-12 h-12 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center dark:bg-blue-950/40 dark:text-blue-300">
                <Upload className="w-6 h-6" aria-hidden="true" />
              </div>
              <h2 className="mt-3 text-base font-semibold text-gray-900 dark:text-gray-100">
                This vault is empty
              </h2>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Drop any file here — PDF, Word, Excel, images, AutoCAD drawings, archives — or choose them
                from your computer.
              </p>
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                <Upload className="w-4 h-4" /> Choose files
              </button>
              <p className="mt-3 text-[11px] text-gray-400">Up to {formatBytes(512 * 1024 * 1024)} per file.</p>
            </div>
          ) : result.rows.length === 0 ? (
            <div
              className="rounded-xl border border-gray-200 bg-white px-6 py-10 text-center dark:border-gray-800 dark:bg-gray-900"
              data-testid="vault-no-results"
            >
              <SearchX className="w-8 h-8 mx-auto text-gray-400" aria-hidden="true" />
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
                {showTrash ? 'The trash is empty.' : 'No files match these filters.'}
              </p>
              {hasFilters && !showTrash && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="mt-2 text-sm font-medium text-blue-700 hover:underline dark:text-blue-300"
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : view === 'list' ? (
            <div className="rounded-xl border border-gray-200 bg-white overflow-hidden dark:border-gray-800 dark:bg-gray-900">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-800/60">
                  <tr>
                    {['Name', 'Type', 'Size', 'Modified', 'Folder'].map((label) => (
                      <th
                        key={label}
                        scope="col"
                        className={cn(
                          'px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400',
                          label === 'Size' || label === 'Modified' || label === 'Type' ? 'hidden sm:table-cell' : '',
                          label === 'Folder' ? 'hidden lg:table-cell' : ''
                        )}
                      >
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {result.rows.map((doc) => (
                    <tr
                      key={doc.id}
                      data-testid={`vault-row-${doc.id}`}
                      tabIndex={0}
                      onClick={() => setSelectedId(doc.id)}
                      onDoubleClick={() => void openDoc(doc)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelectedId(doc.id);
                        }
                      }}
                      className={cn(
                        'cursor-pointer transition-colors',
                        selectedId === doc.id
                          ? 'bg-blue-50 dark:bg-blue-950/40'
                          : 'hover:bg-gray-50 dark:hover:bg-gray-800/60'
                      )}
                    >
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <VaultThumb doc={doc} ctx={ctx ?? { userId: '', projectId }} storage={storage} />
                          <div className="min-w-0">
                            <p className="truncate font-medium text-gray-900 dark:text-gray-100">{doc.name}</p>
                            <p className="text-[11px] text-gray-500 dark:text-gray-400 lg:hidden">
                              {folderLabel(folders, doc.folderId)}
                            </p>
                          </div>
                          {doc.deletedAt && (
                            <span className="ml-auto rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-medium text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
                              Trash
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 hidden sm:table-cell text-gray-600 dark:text-gray-300">
                        {KIND_LABELS[doc.kind]}
                      </td>
                      <td className="px-3 py-2 hidden sm:table-cell text-gray-600 dark:text-gray-300 whitespace-nowrap tabular-nums">
                        {formatBytes(doc.sizeBytes)}
                      </td>
                      <td className="px-3 py-2 hidden sm:table-cell text-gray-500 dark:text-gray-400 whitespace-nowrap">
                        {doc.updatedAt ? new Date(doc.updatedAt).toLocaleDateString() : '—'}
                      </td>
                      <td className="px-3 py-2 hidden lg:table-cell text-gray-500 dark:text-gray-400">
                        <span className="truncate block max-w-[180px]">{folderLabel(folders, doc.folderId)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="grid grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3">
              {result.rows.map((doc) => (
                <button
                  key={doc.id}
                  type="button"
                  data-testid={`vault-card-${doc.id}`}
                  onClick={() => setSelectedId(doc.id)}
                  onDoubleClick={() => void openDoc(doc)}
                  className={cn(
                    'text-left rounded-xl border p-3 bg-white hover:shadow-sm transition dark:bg-gray-900',
                    selectedId === doc.id
                      ? 'border-blue-400 ring-2 ring-blue-100 dark:ring-blue-900'
                      : 'border-gray-200 dark:border-gray-800'
                  )}
                >
                  <div className={cn('w-full h-20 rounded-lg flex items-center justify-center mb-2 overflow-hidden', KIND_TONES[doc.kind])}>
                    <VaultFileIcon kind={doc.kind} className="w-8 h-8" />
                  </div>
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{doc.name}</p>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                    {KIND_LABELS[doc.kind]} · {formatBytes(doc.sizeBytes)}
                  </p>
                  <p className="text-[11px] text-gray-400 dark:text-gray-500 truncate mt-0.5">
                    {folderLabel(folders, doc.folderId)}
                  </p>
                </button>
              ))}
            </div>
          )}

          {result.pages > 1 && (
            <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
              <span>
                Showing {(result.page - 1) * 200 + 1}–{Math.min(result.page * 200, result.total)} of{' '}
                {result.total}
              </span>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                  disabled={result.page <= 1}
                  className="px-2 py-1 rounded border border-gray-300 disabled:opacity-40 dark:border-gray-700"
                >
                  Previous
                </button>
                <button
                  type="button"
                  onClick={() => setPage((value) => Math.min(result.pages, value + 1))}
                  disabled={result.page >= result.pages}
                  className="px-2 py-1 rounded border border-gray-300 disabled:opacity-40 dark:border-gray-700"
                >
                  Next
                </button>
              </div>
            </div>
          )}

          <p className="text-[11px] text-gray-400 dark:text-gray-500">
            {summary.byKind.pdf} PDF · {summary.byKind.drawing} drawings · {summary.byKind.image}{' '}
            images · {summary.files} total
          </p>
        </section>
      </div>

      {selectedDoc && ctx && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => setSelectedId(null)}
            aria-hidden="true"
          />
          <div className="relative w-full max-w-md h-full bg-white shadow-xl overflow-hidden dark:bg-gray-900">
            <VaultDetails
              key={selectedDoc.id}
              doc={selectedDoc}
              folders={folders}
              ctx={ctx}
              storage={storage}
              onClose={() => setSelectedId(null)}
              onOpen={() => void openDoc(selectedDoc)}
              onReveal={() => void revealDoc(selectedDoc)}
              onSaveCopy={() => void saveCopy(selectedDoc)}
              onRename={() => setRenameDoc(selectedDoc)}
              onMove={() => setMoveDoc(selectedDoc)}
              onDelete={() => void deleteDoc(selectedDoc)}
              onRestore={() => restoreDoc(selectedDoc)}
              onForget={() => void forgetDoc(selectedDoc)}
              onPatch={(patch) => patchDoc(selectedDoc, patch)}
            />
          </div>
        </div>
      )}

      <NameModal
        open={Boolean(nameModal) || Boolean(renameDoc)}
        title={renameDoc ? 'Rename file' : nameModal?.mode === 'rename' ? 'Rename folder' : 'New folder'}
        label={renameDoc ? 'File name' : 'Folder name'}
        initial={renameDoc ? renameDoc.name : nameModal?.folder?.name ?? ''}
        confirmLabel={renameDoc ? 'Save' : nameModal?.mode === 'rename' ? 'Save' : 'Create'}
        error={nameError}
        onClose={() => {
          setNameModal(null);
          setRenameDoc(null);
          setNameError('');
        }}
        onSubmit={submitName}
      />

      <MoveModal
        open={Boolean(moveDoc)}
        doc={moveDoc}
        folders={folders}
        onClose={() => setMoveDoc(null)}
        onMove={moveSelected}
      />
    </div>
  );
}
