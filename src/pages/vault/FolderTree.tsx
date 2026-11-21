import { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Trash2,
} from 'lucide-react';
import type { VaultFolder } from '../../types/vault';
import { cn } from '../../utils';

interface Props {
  folders: VaultFolder[];
  counts: Map<string, number>;
  selected: string;
  onSelect: (folder: string) => void;
  onCreate: () => void;
  onRename: (folder: VaultFolder) => void;
  onDelete: (folder: VaultFolder) => void;
  onDropFiles: (folderId: string | null, files: File[]) => void;
}

export function FolderTree({
  folders,
  counts,
  selected,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onDropFiles,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dragOver, setDragOver] = useState<string | null>(null);

  // Deep folders (a DSR day inside a month) must be visible when something
  // selects them, not hidden behind two collapsed parents.
  useEffect(() => {
    if (selected === 'all' || selected === 'root') return;
    const ancestors = new Set<string>();
    let cursor = folders.find((folder) => folder.id === selected)?.parentId ?? null;
    let guard = 0;
    while (cursor && guard < 100) {
      ancestors.add(cursor);
      cursor = folders.find((folder) => folder.id === cursor)?.parentId ?? null;
      guard += 1;
    }
    if (ancestors.size === 0) return;
    setExpanded((prev) => {
      const missing = [...ancestors].filter((id) => !prev.has(id));
      return missing.length === 0 ? prev : new Set([...prev, ...missing]);
    });
  }, [folders, selected]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const acceptDrop = (folderId: string | null) => (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setDragOver(null);
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length) onDropFiles(folderId, files);
  };

  const rowClass = (active: boolean) =>
    cn(
      'group w-full flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-left transition-colors',
      active
        ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-200'
        : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800',
      dragOver === null ? '' : ''
    );

  const renderFolder = (folder: VaultFolder): React.ReactNode => {
    const children = folders
      .filter((row) => row.parentId === folder.id)
      .sort((a, b) => a.name.localeCompare(b.name));
    const isOpen = expanded.has(folder.id);
    const active = selected === folder.id;
    const count = counts.get(folder.id) || 0;
    return (
      <li key={folder.id}>
        <div
          className={cn(
            rowClass(active),
            dragOver === folder.id && 'ring-2 ring-blue-400 bg-blue-50/70 dark:bg-blue-950/40'
          )}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(folder.id);
          }}
          onDragLeave={() => setDragOver((current) => (current === folder.id ? null : current))}
          onDrop={acceptDrop(folder.id)}
        >
          {children.length > 0 ? (
            <button
              type="button"
              onClick={() => toggle(folder.id)}
              aria-label={isOpen ? `Collapse ${folder.name}` : `Expand ${folder.name}`}
              aria-expanded={isOpen}
              className="p-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
            >
              {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            </button>
          ) : (
            <span className="w-4" />
          )}
          <button
            type="button"
            onClick={() => {
              onSelect(folder.id);
              if (children.length) setExpanded((prev) => new Set(prev).add(folder.id));
            }}
            className="flex-1 min-w-0 flex items-center gap-1.5"
            data-testid={`vault-folder-${folder.id}`}
            aria-current={active ? 'true' : undefined}
          >
            {active ? (
              <FolderOpen className="w-4 h-4 shrink-0" aria-hidden="true" />
            ) : (
              <Folder className="w-4 h-4 shrink-0" aria-hidden="true" />
            )}
            <span className="truncate">{folder.name}</span>
            {folder.system && (
              <span
                className="shrink-0 rounded bg-emerald-100 px-1 py-0.5 text-[9px] font-semibold uppercase text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
                title="Managed by Daily Site Reports"
                aria-label="Managed by Daily Site Reports"
                data-testid={`vault-folder-managed-${folder.id}`}
              >
                DSR
              </span>
            )}
            <span className="ml-auto text-[11px] text-gray-400 tabular-nums">{count || ''}</span>
          </button>
          <span className="hidden group-hover:flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => onRename(folder)}
              aria-label={`Rename ${folder.name}`}
              className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700"
            >
              <Pencil className="w-3 h-3" />
            </button>
            {!folder.system && (
              <button
                type="button"
                onClick={() => onDelete(folder)}
                aria-label={`Delete ${folder.name}`}
                data-testid={`vault-folder-delete-${folder.id}`}
                className="p-1 rounded text-gray-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            )}
          </span>
        </div>
        {isOpen && children.length > 0 && (
          <ul className="ml-4 border-l border-gray-200 dark:border-gray-700 pl-1 space-y-0.5">
            {children.map(renderFolder)}
          </ul>
        )}
      </li>
    );
  };

  return (
    <aside
      className="w-56 shrink-0 hidden md:flex flex-col gap-2 min-h-0"
      aria-label="Vault folders"
      data-testid="vault-folder-tree"
    >
      <div className="flex items-center justify-between px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Folders
        </h2>
        <button
          type="button"
          onClick={onCreate}
          aria-label="New folder"
          className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-gray-800 dark:hover:text-gray-200"
        >
          <FolderPlus className="w-4 h-4" />
        </button>
      </div>

      <nav className="overflow-y-auto pr-1">
        <ul className="space-y-0.5">
          <li>
            <button
              type="button"
              onClick={() => onSelect('all')}
              data-testid="vault-folder-all"
              className={rowClass(selected === 'all')}
              aria-current={selected === 'all' ? 'true' : undefined}
            >
              <FolderOpen className="w-4 h-4" aria-hidden="true" />
              <span className="flex-1">All files</span>
              <span className="text-[11px] text-gray-400 tabular-nums">{counts.get('all') || ''}</span>
            </button>
          </li>
          <li>
            <div
              className={cn(
                rowClass(selected === 'root'),
                dragOver === 'root' && 'ring-2 ring-blue-400 bg-blue-50/70 dark:bg-blue-950/40'
              )}
              onDragOver={(event) => {
                event.preventDefault();
                setDragOver('root');
              }}
              onDragLeave={() => setDragOver((current) => (current === 'root' ? null : current))}
              onDrop={acceptDrop(null)}
            >
              <span className="w-4" />
              <button
                type="button"
                onClick={() => onSelect('root')}
                data-testid="vault-folder-root"
                className="flex-1 flex items-center gap-1.5"
                aria-current={selected === 'root' ? 'true' : undefined}
              >
                <Folder className="w-4 h-4" aria-hidden="true" />
                <span className="flex-1">Unsorted</span>
                <span className="text-[11px] text-gray-400 tabular-nums">
                  {counts.get('root') || ''}
                </span>
              </button>
            </div>
          </li>
          {folders.filter((folder) => !folder.parentId).map(renderFolder)}
        </ul>
      </nav>
      <p className="px-1 text-[11px] text-gray-400 dark:text-gray-500">
        Drop files on a folder to file them there.
      </p>
    </aside>
  );
}
