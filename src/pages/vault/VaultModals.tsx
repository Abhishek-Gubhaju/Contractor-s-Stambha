import { useEffect, useState } from 'react';
import { Folder, FolderOpen } from 'lucide-react';
import { Modal } from '../../components/ui';
import type { VaultDocument, VaultFolder } from '../../types/vault';
import { folderPathNames } from '../../services/vault/vaultService';
import { cn } from '../../utils';

interface NameModalProps {
  open: boolean;
  title: string;
  label: string;
  initial?: string;
  confirmLabel: string;
  onClose: () => void;
  onSubmit: (value: string) => void;
  error?: string;
}

export function NameModal({
  open,
  title,
  label,
  initial = '',
  confirmLabel,
  onClose,
  onSubmit,
  error,
}: NameModalProps) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);

  return (
    <Modal isOpen={open} onClose={onClose} title={title} size="sm">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(value);
        }}
      >
        <label
          htmlFor="vault-name-input"
          className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1"
        >
          {label}
        </label>
        <input
          id="vault-name-input"
          data-testid="vault-name-input"
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          maxLength={180}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-900 dark:border-gray-700 dark:text-gray-100"
        />
        {error && (
          <p className="mt-2 text-xs text-rose-600 dark:text-rose-400" role="alert">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            data-testid="vault-name-save"
            className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700"
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface MoveModalProps {
  open: boolean;
  doc: VaultDocument | null;
  folders: VaultFolder[];
  onClose: () => void;
  onMove: (folderId: string | null) => void;
}

export function MoveModal({ open, doc, folders, onClose, onMove }: MoveModalProps) {
  return (
    <Modal isOpen={open} onClose={onClose} title={`Move ${doc?.name ?? 'file'}`} size="sm">
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
        Choose the folder this file belongs to.
      </p>
      <ul className="max-h-80 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg">
        <li>
          <button
            type="button"
            onClick={() => onMove(null)}
            data-testid="vault-move-root"
            className={cn(
              'w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-gray-800',
              !doc?.folderId ? 'text-blue-700 dark:text-blue-300 font-medium' : 'text-gray-700 dark:text-gray-200'
            )}
          >
            <Folder className="w-4 h-4" aria-hidden="true" />
            Unsorted
          </button>
        </li>
        {folders.map((folder) => {
          const path = folderPathNames(folders, folder.id);
          return (
            <li key={folder.id}>
              <button
                type="button"
                onClick={() => onMove(folder.id)}
                data-testid={`vault-move-${folder.id}`}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-gray-800',
                  doc?.folderId === folder.id
                    ? 'text-blue-700 dark:text-blue-300 font-medium'
                    : 'text-gray-700 dark:text-gray-200'
                )}
              >
                <FolderOpen className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{path.join(' / ')}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
