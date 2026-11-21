// Settings card for the File Vault: where the bytes live, how much is stored,
// and the one action that matters — open that folder in Finder/Explorer.
import { useEffect, useMemo, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { isDesktopApp } from '../../services/backup/desktop';
import { activeUser } from '../../services/auth/authService';
import { useActiveProject } from '../../services/projectScope';
import { getVaultStorage } from '../../services/vault/vaultStorage';
import { listDocuments, vaultSummary } from '../../services/vault/vaultService';
import { formatBytes } from '../../services/staffService';
import { notify } from '../../components/ui/DialogHost';

export function VaultCard() {
  const projectId = useActiveProject();
  const desktop = isDesktopApp();
  const storage = getVaultStorage();
  const userId = activeUser()?.id ?? '';
  // A new object each render would restart the effect after its own setState,
  // which React reports as "maximum update depth exceeded".
  const ctx = useMemo(
    () => (userId ? { userId, projectId } : null),
    [projectId, userId]
  );
  const [folder, setFolder] = useState<string>('');
  const [usage, setUsage] = useState<{ files: number; bytes: number } | null>(null);
  const summary = vaultSummary(listDocuments(projectId));

  useEffect(() => {
    let cancelled = false;
    setUsage(null);
    if (!ctx) {
      setFolder('');
      return;
    }
    if (storage.folderPath) {
      storage
        .folderPath(ctx)
        .then((value) => {
          if (!cancelled) setFolder(value);
        })
        .catch(() => {
          if (!cancelled) setFolder('');
        });
    }
    if (storage.usage) {
      storage
        .usage(ctx)
        .then((value) => {
          if (!cancelled) setUsage(value);
        })
        .catch(() => {
          if (!cancelled) setUsage(null);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [ctx, storage]);

  const reveal = async () => {
    if (!ctx || !storage.revealFolder) return;
    try {
      await storage.revealFolder(ctx);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'The vault folder could not be opened.', 'error');
    }
  };

  return (
    <div className="bg-white rounded-xl border p-6" data-testid="vault-card">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold mb-1">File Vault</h2>
          <p className="text-xs text-gray-500">
            {desktop
              ? 'Documents for this job are kept as real files in the app’s data folder. Backups copy them into each run’s Vault/ folder.'
              : 'In a browser the vault lives in this browser’s storage and is not part of a ZIP backup. Use the desktop app for real documents.'}
          </p>
        </div>
        {desktop && (
          <button
            type="button"
            onClick={() => void reveal()}
            disabled={!ctx}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-50 rounded-lg px-3 py-1.5"
          >
            <FolderOpen className="w-4 h-4" aria-hidden="true" /> Open vault folder
          </button>
        )}
      </div>
      <p className="mt-3 text-sm text-gray-800" data-testid="vault-card-usage">
        {summary.files} {summary.files === 1 ? 'file' : 'files'} · {formatBytes(summary.bytes)}
        {usage && usage.files !== summary.files
          ? ` · ${usage.files} on disk`
          : ''}
      </p>
      {folder && (
        <p className="mt-1 text-[11px] text-gray-400 font-mono break-all" data-testid="vault-card-folder">
          {folder}
        </p>
      )}
    </div>
  );
}
