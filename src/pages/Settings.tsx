// Settings — company preferences + the two masters job costing rolls up by.
//
// Project identity (name, client, contract value, EAC) lives in ONE place: the
// Projects (jobs) master below. The old "Project Settings" card duplicated those
// fields, nothing read them, and saving it rewrote `contractoros_settings` as a
// whole — silently dropping the fiscal-year start and payroll's wageUnpaidDays.
import { useEffect, useState } from 'react';
import { FolderOpen, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  loadProjects,
  loadCostCodes,
  upsertProject,
  removeProject,
  upsertCostCode,
  removeCostCode,
  type Project,
  type CostCode,
} from '../services/masterData';
import { setActiveProject, useActiveProject } from '../services/projectScope';
import { loadTaxSettings, saveTaxSettings, type TaxSettings } from '../services/taxService';
import { loadCompany, saveCompany, type CompanyProfile } from '../services/companyService';
import { loadParties, upsertParty, removeParty, type Party, type PartyType } from '../services/partyService';
import {
  lastBackup,
  listLocalBackups,
  pendingRestore,
  restoreDesktopRun,
  restoreFromZip,
  runBackup,
  undoLastRestore,
  type LocalBackupRun,
  type RestoreResult,
} from '../services/backup/backupService';
import { chooseBackupFolderNative, isDesktopApp, revealBackupFolder } from '../services/backup/desktop';
import { formatBytes } from '../services/staffService';
import {
  backupLocationLabel,
  backupLocationProblem,
  loadBackupLocation,
  saveBackupLocation,
} from '../services/backup/backupLocation';
import {
  MIRROR_UPDATED_EVENT,
  mirrorStatus,
  restoreFromMirror,
  flushMirror,
  type MirrorStatus,
} from '../services/storage/mirror';
import { confirmDialog, destroyDialog } from '../components/ui/DialogHost';
import { SecurityCard } from './settings/SecurityCard';
import { VaultCard } from './settings/VaultCard';
import { NotificationsCard } from './settings/NotificationsCard';

export default function SettingsPage({ timezone, setTimezone }: { timezone: string; setTimezone: (v: string) => void }) {
  // Masters — the two dimensions job costing rolls up by.
  const [projects, setProjects] = useState<Project[]>(() => loadProjects());
  const [codes, setCodes] = useState<CostCode[]>(() => loadCostCodes());
  const [newProject, setNewProject] = useState({ id: '', name: '', client: '' });
  const [newCode, setNewCode] = useState({ code: '', name: '' });
  const [masterError, setMasterError] = useState('');
  const [tax, setTax] = useState<TaxSettings>(() => loadTaxSettings());
  const [company, setCompany] = useState<CompanyProfile>(() => loadCompany());
  const [companyNote, setCompanyNote] = useState('');
  const [parties, setParties] = useState<Party[]>(() => loadParties());
  const [newParty, setNewParty] = useState<{ name: string; type: PartyType; pan: string }>({ name: '', type: 'client', pan: '' });
  const [backupMsg, setBackupMsg] = useState('');
  const [backupLocation, setBackupLocation] = useState<string | null>(() => loadBackupLocation());
  const [locationMsg, setLocationMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [localRuns, setLocalRuns] = useState<LocalBackupRun[]>([]);
  const [restoreInfo, setRestoreInfo] = useState(() => pendingRestore());
  const [mirror, setMirror] = useState<MirrorStatus | null>(null);
  const activeProject = useActiveProject();
  const previous = lastBackup();

  const desktop = isDesktopApp();

  const refreshLocalRuns = async () => {
    if (!desktop) return;
    try {
      setLocalRuns(await listLocalBackups());
    } catch (e) {
      setBackupMsg(`Could not list saved backups: ${errorText(e)}`);
    }
  };

  useEffect(() => {
    void refreshLocalRuns();
    void refreshMirror();
    // A save can land while this page is open: refresh the card when it does.
    const onMirrorUpdated = () => void refreshMirror();
    window.addEventListener(MIRROR_UPDATED_EVENT, onMirrorUpdated);
    return () => window.removeEventListener(MIRROR_UPDATED_EVENT, onMirrorUpdated);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshMirror = async () => {
    if (!desktop) return;
    try {
      setMirror(await mirrorStatus());
    } catch (e) {
      setBackupMsg(`Could not read the durable copy: ${errorText(e)}`);
    }
  };

  const doBackup = async () => {
    setBusy(true);
    try {
      const result = await runBackup();
      const vaultFiles = result.vaultFiles ? ` · ${result.vaultFiles} vault file(s)` : '';
      setBackupMsg(
        `Backed up ${result.fileCount} files (${Math.max(1, Math.round(result.bytes / 1024))} KB)${vaultFiles} → ${result.location}${result.vaultError ? ` — vault copy incomplete: ${result.vaultError}` : ''}`
      );
      await refreshLocalRuns();
    } catch (e) {
      setBackupMsg(`Backup failed: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const confirmRestore = async (source: string, mode: 'replace' | 'merge' = 'replace') => {
    const merge = mode === 'merge';
    const options = {
      title: merge ? 'Restore this mirrored copy?' : 'Restore this backup?',
      message: merge
        ? `The record sets in ${source} replace their current versions. Anything the mirror did not hold — newer modules, other jobs — is kept, so nothing is swept away.\n\nA safety copy is kept first, so you can undo immediately afterwards.`
        : `Every project and company record in ${source} replaces what is on this computer now. Data created after that backup, in those projects, is removed.\n\nA safety copy is kept first, so you can undo immediately afterwards.`,
      confirmLabel: merge ? 'Restore mirrored copy' : 'Restore backup',
    };
    // A full restore overwrites current data, so it needs the account secret;
    // a merge only overlays the sets the mirror held.
    return merge ? confirmDialog(options) : destroyDialog(options);
  };

  const finishRestore = async (result: RestoreResult) => {
    const skipped = result.skipped ? `, ${result.skipped} derived file(s) skipped` : '';
    const cleared = result.cleared ? `, ${result.cleared} newer record(s) replaced` : '';
    const safety = result.snapshot ? 'A pre-restore copy is available under Undo.' : 'No pre-restore copy could be stored.';
    const vault =
      result.vaultRestored !== undefined
        ? ` Vault: ${result.vaultRestored} file(s) recovered${result.vaultSkipped ? `, ${result.vaultSkipped} already present` : ''}.`
        : '';
    const vaultError = result.vaultError ? ` Vault copy failed: ${result.vaultError}` : '';
    setBackupMsg(
      `Restored ${result.restored} file(s) from backup ${result.runId}${skipped}${cleared}. ${safety}${vault}${vaultError}`
    );
    setRestoreInfo(pendingRestore());
    const restoredProjects = loadProjects();
    setProjects(restoredProjects);
    setCodes(loadCostCodes());
    setCompany(loadCompany());
    setParties(loadParties());
    setTax(loadTaxSettings());
    // The job that was open may not exist in the restored file.
    if (restoredProjects.length > 0 && !restoredProjects.some((p) => p.id === activeProject)) {
      setActiveProject(restoredProjects[0].id);
    }
    const reload = await confirmDialog({
      title: 'Restore complete',
      message: 'Reload the app now so every screen shows the restored books?',
      confirmLabel: 'Reload now',
      cancelLabel: 'Later',
    });
    if (reload) window.location.reload();
  };

  const doRestore = async (file?: File) => {
    if (!file) return;
    const ok = await confirmRestore(file.name);
    if (!ok) return;
    setBusy(true);
    try {
      await finishRestore(await restoreFromZip(file));
    } catch (e) {
      setBackupMsg(`Restore failed: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const doRestoreRun = async (run: LocalBackupRun) => {
    const when = run.createdAt ? new Date(run.createdAt).toLocaleString() : run.runId;
    const ok = await confirmRestore(`the backup from ${when}`);
    if (!ok) return;
    setBusy(true);
    try {
      await finishRestore(await restoreDesktopRun(run.runId));
      await refreshLocalRuns();
    } catch (e) {
      setBackupMsg(`Restore failed: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const doUndoRestore = async () => {
    const ok = await destroyDialog({
      title: 'Undo the last restore',
      message: 'Put the data back exactly as it was before the restore? The restored backup is not deleted.',
      confirmLabel: 'Undo restore',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const result = undoLastRestore();
      setBackupMsg(`Undid the last restore (${result.reverted} key(s) put back). Reload to see it.`);
      setRestoreInfo(null);
      const reload = await confirmDialog({
        title: 'Undo complete',
        message: 'Reload the app now to show the previous data?',
        confirmLabel: 'Reload now',
        cancelLabel: 'Later',
      });
      if (reload) window.location.reload();
    } catch (e) {
      setBackupMsg(`Undo failed: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const doReveal = async () => {
    try {
      await revealBackupFolder(backupLocation);
    } catch (e) {
      setBackupMsg(`Could not open the backup folder: ${errorText(e)}`);
    }
  };

  const applyBackupLocation = async (path: string) => {
    const problem = backupLocationProblem(path);
    if (problem) {
      setLocationMsg(problem);
      return;
    }
    try {
      saveBackupLocation(path);
      const saved = loadBackupLocation();
      setBackupLocation(saved);
      setLocationMsg(
        saved ? 'Backups will be saved there from now on.' : 'Backups will be saved to the default folder again.'
      );
      await refreshLocalRuns();
    } catch (e) {
      setLocationMsg(errorText(e));
    }
  };

  const chooseBackupLocation = async () => {
    if (busy) return;
    try {
      const picked = await chooseBackupFolderNative(backupLocation);
      if (!picked) return;
      await applyBackupLocation(picked);
    } catch (e) {
      setLocationMsg(errorText(e));
    }
  };

  const resetBackupLocation = async () => {
    try {
      saveBackupLocation(null);
      setBackupLocation(null);
      setLocationMsg('Backups will be saved to the default Documents/Stambha folder.');
      await refreshLocalRuns();
    } catch (e) {
      setLocationMsg(errorText(e));
    }
  };

  const doRestoreMirror = async (which: 'current' | 'previous') => {
    const meta = which === 'current' ? mirror?.current : mirror?.previous;
    const when = meta?.savedAt ? new Date(meta.savedAt).toLocaleString() : 'the last save';
    const ok = await confirmRestore(`${which === 'current' ? 'the latest' : 'the previous'} mirrored copy from ${when}`, 'merge');
    if (!ok) return;
    setBusy(true);
    try {
      // Capture the newest save first — but only for "current": flushing
      // before reading "previous" would rotate the old copy away.
      if (which === 'current') await flushMirror();
      await finishRestore(await restoreFromMirror(which));
      await refreshMirror();
    } catch (e) {
      setBackupMsg(`Mirror restore failed: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

  // Tax defaults only pre-fill new documents; each bill/invoice carries its own
  // rate, so changing these never rewrites posted history.
  const updateTax = (patch: Partial<TaxSettings>) => setTax(saveTaxSettings(patch));

  // The printed letterhead: name + PAN are the fields a tax invoice cannot do
  // without, so they are edited here and travel to every document.
  const updateCompany = (patch: Partial<CompanyProfile>) => {
    try {
      setCompany(saveCompany(patch));
      setCompanyNote('');
    } catch {
      setCompanyNote('Could not save the company details — the app\u2019s offline storage is full.');
    }
  };

  const pickLogo = (file: File | null) => {
    if (!file) return;
    // The logo is stored inside the same offline storage as the books. A phone
    // photo is megabytes; allowing it would exhaust the quota and make every
    // later save fail, so the size is checked before reading.
    if (file.size > 400 * 1024) {
      setCompanyNote('That image is larger than 400 KB. Choose a smaller logo.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => updateCompany({ logo: String(reader.result || '') });
    reader.onerror = () => setCompanyNote('Could not read that image.');
    reader.readAsDataURL(file);
  };

  const addParty = () => {
    try {
      upsertParty({ name: newParty.name, type: newParty.type, pan: newParty.pan });
      setParties(loadParties());
      setNewParty({ name: '', type: 'client', pan: '' });
      setMasterError('');
    } catch (e) {
      setMasterError(errorText(e));
    }
  };

  const updateParty = (id: string, patch: Partial<Party>) => {
    const current = loadParties().find((p) => p.id === id);
    if (!current) return;
    upsertParty({ ...current, ...patch });
    setParties(loadParties());
  };

  const deleteParty = async (id: string) => {
    const ok = await destroyDialog({
      title: 'Remove party',
      message: 'Remove this client/supplier? Documents already posted keep their name and PAN.',
      confirmLabel: 'Remove party',
    });
    if (!ok) return;
    removeParty(id);
    setParties(loadParties());
  };

  const addProject = () => {
    try {
      const created = upsertProject({ ...newProject, status: 'active', startDate: '', endDate: '' });
      setProjects(loadProjects());
      setActiveProject(created.id);
      setNewProject({ id: '', name: '', client: '' });
      setMasterError('');
    } catch (e) {
      setMasterError(errorText(e));
    }
  };

  const updateProject = (id: string, patch: Partial<Project>) => {
    const current = loadProjects().find((p) => p.id === id);
    if (!current) return;
    upsertProject({ ...current, ...patch });
    setProjects(loadProjects());
  };

  const deleteProject = async (id: string) => {
    const ok = await destroyDialog({
      title: 'Remove project',
      message: `Remove project ${id}? Costs already posted to it stay in the ledger.`,
      confirmLabel: 'Remove project',
    });
    if (!ok) return;
    removeProject(id);
    setProjects(loadProjects());
  };

  const addCode = () => {
    try {
      upsertCostCode({ code: newCode.code, name: newCode.name });
      setCodes(loadCostCodes());
      setNewCode({ code: '', name: '' });
      setMasterError('');
    } catch (e) {
      setMasterError(errorText(e));
    }
  };

  const deleteCode = async (code: string) => {
    const ok = await destroyDialog({
      title: 'Remove cost code',
      message: `Remove cost code ${code}? Lines already posted keep their category name.`,
      confirmLabel: 'Remove cost code',
    });
    if (!ok) return;
    removeCostCode(code);
    setCodes(loadCostCodes());
  };

  return (
    <div className="space-y-6">
      <div>
        <h1>Settings</h1>
        <p>Company preferences, jobs and cost codes.</p>
      </div>

      <div className="bg-white rounded-xl border p-6">
        <h2 className="text-lg font-bold mb-1">Preferences</h2>
        <p className="text-xs text-gray-500 mb-4">
          Used for dates and payroll in every job.
        </p>
        <label className="block text-sm font-medium mb-1" htmlFor="settings-timezone">Timezone</label>
        <select
          id="settings-timezone"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          className="w-full sm:w-80 border rounded-lg px-3 py-2 text-sm"
          aria-label="Timezone"
        >
          <option value="Asia/Kathmandu">Asia/Kathmandu (UTC+05:45)</option>
          <option value="UTC">UTC</option>
        </select>
      </div>

      <div className="bg-white rounded-xl border p-6">
        <h2 className="text-lg font-bold mb-1">Tax</h2>
        <p className="text-xs text-gray-500 mb-4">
          Defaults for new bills and invoices.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <label className="text-[11px] text-gray-500">
            VAT
            <select
              className="mt-0.5 w-full border border-gray-200 rounded px-2 py-1 text-sm text-gray-900"
              value={tax.vatEnabled ? 'on' : 'off'}
              onChange={(e) => updateTax({ vatEnabled: e.target.value === 'on' })}
              aria-label="VAT enabled"
            >
              <option value="on">Charged</option>
              <option value="off">Not charged</option>
            </select>
          </label>
          <label className="text-[11px] text-gray-500">
            VAT rate %
            <input
              type="number"
              min={0}
              max={100}
              step="any"
              className="mt-0.5 w-full border border-gray-200 rounded px-2 py-1 text-sm text-gray-900"
              value={tax.vatRate}
              onChange={(e) => updateTax({ vatRate: Number(e.target.value) || 0 })}
              aria-label="VAT rate"
            />
          </label>
          <label className="text-[11px] text-gray-500">
            TDS
            <select
              className="mt-0.5 w-full border border-gray-200 rounded px-2 py-1 text-sm text-gray-900"
              value={tax.tdsEnabled ? 'on' : 'off'}
              onChange={(e) => updateTax({ tdsEnabled: e.target.value === 'on' })}
              aria-label="TDS enabled"
            >
              <option value="on">Withheld</option>
              <option value="off">Not withheld</option>
            </select>
          </label>
          <label className="text-[11px] text-gray-500">
            TDS rate % (services / rent)
            <input
              type="number"
              min={0}
              max={100}
              step="any"
              className="mt-0.5 w-full border border-gray-200 rounded px-2 py-1 text-sm text-gray-900"
              value={tax.tdsRate}
              onChange={(e) => updateTax({ tdsRate: Number(e.target.value) || 0 })}
              aria-label="TDS rate"
            />
          </label>
        </div>
      </div>

      <div className="bg-white rounded-xl border p-6">
        <h2 className="text-lg font-bold mb-1">Clients &amp; suppliers</h2>
        <p className="text-xs text-gray-500 mb-4">
          Filled into every document and the purchase/sales register.
        </p>
        <div className="grid grid-cols-4 gap-2 mb-3">
          <input
            className="border rounded-lg px-2.5 py-2 text-sm"
            placeholder="Party name"
            value={newParty.name}
            onChange={(e) => setNewParty({ ...newParty, name: e.target.value })}
            aria-label="New party name"
          />
          <select
            className="border rounded-lg px-2.5 py-2 text-sm"
            value={newParty.type}
            onChange={(e) => setNewParty({ ...newParty, type: e.target.value as PartyType })}
            aria-label="New party type"
          >
            <option value="client">Client</option>
            <option value="supplier">Supplier</option>
            <option value="both">Both</option>
          </select>
          <input
            className="border rounded-lg px-2.5 py-2 text-sm font-mono"
            placeholder="PAN (9 digits)"
            value={newParty.pan}
            onChange={(e) => setNewParty({ ...newParty, pan: e.target.value })}
            aria-label="New party PAN"
          />
          <button onClick={addParty} className="inline-flex items-center justify-center gap-1.5 text-sm font-medium text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded-lg px-3 py-1.5">
            <Plus className="w-4 h-4" /> Add party
          </button>
        </div>
        <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden max-h-80 overflow-y-auto">
          {parties.length === 0 && <li className="px-3 py-3 text-xs text-gray-400">No clients or suppliers yet.</li>}
          {parties.map((p) => (
            <li key={p.id} className="px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-gray-900">{p.name}</span>
                <span className="flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-wide text-gray-400">{p.type}</span>
                  <button onClick={() => deleteParty(p.id)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded" aria-label={`Remove party ${p.name}`}>
                    <Trash2 className="w-4 h-4" />
                  </button>
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2 mt-1">
                <label className="text-[11px] text-gray-500">
                  PAN
                  <input
                    className="mt-0.5 w-full border border-gray-200 rounded px-2 py-1 text-xs font-mono"
                    value={p.pan}
                    onChange={(e) => updateParty(p.id, { pan: e.target.value })}
                    aria-label={`Party PAN ${p.name}`}
                  />
                </label>
                <label className="text-[11px] text-gray-500">
                  Address
                  <input
                    className="mt-0.5 w-full border border-gray-200 rounded px-2 py-1 text-xs"
                    value={p.address}
                    onChange={(e) => updateParty(p.id, { address: e.target.value })}
                    aria-label={`Party address ${p.name}`}
                  />
                </label>
                <label className="text-[11px] text-gray-500">
                  Credit days
                  <input
                    type="number"
                    min={0}
                    className="mt-0.5 w-full border border-gray-200 rounded px-2 py-1 text-xs"
                    value={p.creditDays}
                    onChange={(e) => updateParty(p.id, { creditDays: Number(e.target.value) || 0 })}
                    aria-label={`Party credit days ${p.name}`}
                  />
                </label>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="bg-white rounded-xl border p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">Backups</h2>
            <p className="mt-0.5 text-xs text-gray-500">
              {desktop
                ? 'One folder per account on this computer. Every backup is kept.'
                : 'In a browser each backup downloads as one ZIP.'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={doBackup}
              disabled={busy}
              data-testid="backup-now"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-white bg-gray-900 hover:bg-gray-800 disabled:opacity-50 rounded-lg px-3 py-1.5"
            >
              Back up now
            </button>
            {desktop && (
              <button
                onClick={doReveal}
                disabled={busy}
                className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-50 rounded-lg px-3 py-1.5"
              >
                Open backup folder
              </button>
            )}
            <label className={`inline-flex items-center gap-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-lg px-3 py-1.5 cursor-pointer ${busy ? 'opacity-50 pointer-events-none' : ''}`}>
              Restore from .zip
              <input
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                data-testid="restore-file"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  // Allow choosing the same file again after a failed attempt.
                  e.target.value = '';
                  void doRestore(file);
                }}
              />
            </label>
          </div>
        </div>
        {desktop && (
          <div className="mt-4 border-t border-gray-100 pt-4" data-testid="backup-location">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-800">Backup folder</p>
                <p
                  className="mt-0.5 break-all font-mono text-xs text-gray-600"
                  data-testid="backup-location-current"
                  title={backupLocationLabel(backupLocation)}
                >
                  {backupLocationLabel(backupLocation)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => void chooseBackupLocation()}
                  disabled={busy}
                  data-testid="backup-location-choose"
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-lg px-3 py-1.5"
                >
                  <FolderOpen className="w-4 h-4" aria-hidden="true" />
                  Choose folder…
                </button>
                {backupLocation && (
                  <button
                    onClick={() => void resetBackupLocation()}
                    disabled={busy}
                    data-testid="backup-location-reset"
                    className="text-sm font-medium text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-50 rounded-lg px-3 py-1.5"
                  >
                    Use default
                  </button>
                )}
              </div>
            </div>
            {locationMsg && (
              <p className="mt-1 text-xs text-indigo-700" data-testid="backup-location-msg">{locationMsg}</p>
            )}
          </div>
        )}
        {previous && !backupMsg && (
          <p className="mt-3 text-xs text-gray-500">
            Last backup {new Date(previous.runId.slice(0, 4) + '-' + previous.runId.slice(4, 6) + '-' + previous.runId.slice(6, 8)).toLocaleDateString()} · {previous.fileCount} files · {formatBytes(previous.bytes)}{previous.mode === 'desktop' ? '' : ' · downloaded ZIP'}
          </p>
        )}
        {previous && !backupMsg && (() => {
          const made = new Date(`${previous.runId.slice(0, 4)}-${previous.runId.slice(4, 6)}-${previous.runId.slice(6, 8)}`);
          const days = Math.floor((Date.now() - made.getTime()) / 86400000);
          return days >= 7 ? (
            <p className="mt-1 text-xs text-amber-700" data-testid="backup-stale">
              {days} days old — back up before closing the books.
            </p>
          ) : null;
        })()}

        {desktop && (
          <div className="mt-4 border-t border-gray-100 pt-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-gray-800">Saved backups</h3>
              <button
                onClick={() => void refreshLocalRuns()}
                disabled={busy}
                className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 disabled:opacity-50"
              >
                <RefreshCw className="w-3 h-3" aria-hidden="true" /> Refresh
              </button>
            </div>
            {localRuns.length === 0 ? (
              <p className="text-xs text-gray-500" data-testid="no-local-backups">
                No backups in this folder yet.
              </p>
            ) : (
              <ul className="max-h-64 divide-y divide-gray-100 overflow-y-auto rounded-lg border border-gray-200">
                {localRuns.map((run) => (
                  <li key={run.runId} className="flex items-center justify-between gap-3 px-3 py-2 text-sm" data-testid="backup-run">
                    <span className="min-w-0 text-gray-900">
                      {run.createdAt ? new Date(run.createdAt).toLocaleString() : run.runId}
                    </span>
                    <span className="whitespace-nowrap text-xs text-gray-500">{run.files} files · {formatBytes(run.bytes)}</span>
                    <button
                      onClick={() => void doRestoreRun(run)}
                      disabled={busy}
                      className="text-xs font-medium text-rose-700 bg-white border border-rose-200 hover:bg-rose-50 disabled:opacity-50 rounded-md px-2.5 py-1 whitespace-nowrap"
                    >
                      Restore
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {restoreInfo && (
          <div className="mt-4 bg-white border border-gray-200 border-l-2 border-l-amber-600 rounded-lg px-3 py-2 flex flex-wrap items-center justify-between gap-2" data-testid="undo-restore">
            <p className="text-xs text-amber-900">
              Restore applied{' '}
              {restoreInfo.at ? new Date(restoreInfo.at).toLocaleString() : 'earlier'} ·{' '}
              {restoreInfo.keys} records replaced
            </p>
            <button
              onClick={() => void doUndoRestore()}
              disabled={busy}
              className="text-xs font-medium text-amber-900 bg-white border border-amber-300 hover:bg-amber-100 disabled:opacity-50 rounded-md px-2.5 py-1"
            >
              Undo last restore
            </button>
          </div>
        )}

        {desktop && (
          <div className="mt-4 border-t border-gray-100 pt-4" data-testid="mirror-section">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-gray-800">Safety copies</h3>
                <p className="text-xs text-gray-500">Saved automatically after every change.</p>
              </div>
              <button
                onClick={() => void refreshMirror()}
                disabled={busy}
                className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 disabled:opacity-50"
              >
                <RefreshCw className="w-3 h-3" aria-hidden="true" /> Refresh
              </button>
            </div>
            {!mirror?.current && !mirror?.previous ? (
              <p className="text-xs text-gray-500" data-testid="mirror-empty">
                No safety copy yet.
              </p>
            ) : (
              <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden">
                {([
                  ['current', mirror?.current],
                  ['previous', mirror?.previous],
                ] as const).map(([which, meta]) =>
                  meta ? (
                    <li key={which} className="px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-sm" data-testid={`mirror-${which}`}>
                      <span className="min-w-0">
                        <span className="block text-gray-900">
                          {which === 'current' ? 'Latest save' : 'Previous save'}
                          {' · '}
                          {meta.savedAt ? new Date(meta.savedAt).toLocaleString() : 'unknown time'}
                        </span>
                        <span className="block text-xs text-gray-500">
                          {meta.keys} records · {formatBytes(meta.bytes)}
                        </span>
                      </span>
                      <button
                        onClick={() => void doRestoreMirror(which)}
                        disabled={busy}
                        className="text-xs font-medium text-rose-700 bg-white border border-rose-200 hover:bg-rose-50 disabled:opacity-50 rounded-md px-2.5 py-1 whitespace-nowrap"
                      >
                        Restore this save
                      </button>
                    </li>
                  ) : null
                )}
              </ul>
            )}
          </div>
        )}

        {backupMsg && <p className="mt-3 text-xs text-gray-700 break-words" data-testid="backup-message">{backupMsg}</p>}
      </div>

      <VaultCard />

      <NotificationsCard />

      <SecurityCard />

      {masterError && (
        <div className="bg-white border border-gray-200 border-l-2 border-l-red-600 rounded-lg px-4 py-3 text-sm text-red-700" role="alert">
          {masterError}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        <div className="space-y-6">
          {/* Projects master */}
        <div className="bg-white rounded-xl border p-6">
          <h2 className="text-lg font-bold mb-1">Projects (jobs)</h2>
          <p className="text-xs text-gray-500 mb-4">
            Each job keeps its own BOQ, DSR, team, billing, ledger and letterhead.
          </p>

          <div className="grid grid-cols-3 gap-2 mb-3">
            <input
              className="border rounded-lg px-2.5 py-2 text-sm font-mono"
              placeholder="PRJ-002"
              value={newProject.id}
              onChange={(e) => setNewProject({ ...newProject, id: e.target.value })}
              aria-label="New project job number"
            />
            <input
              className="border rounded-lg px-2.5 py-2 text-sm"
              placeholder="Project name"
              value={newProject.name}
              onChange={(e) => setNewProject({ ...newProject, name: e.target.value })}
              aria-label="New project name"
            />
            <input
              className="border rounded-lg px-2.5 py-2 text-sm"
              placeholder="Client"
              value={newProject.client}
              onChange={(e) => setNewProject({ ...newProject, client: e.target.value })}
              aria-label="New project client"
            />
          </div>
          <button
            onClick={addProject}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded-lg px-3 py-1.5 mb-4"
          >
            <Plus className="w-4 h-4" /> Add project
          </button>

          <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden">
            {projects.map((p) => (
              <li key={p.id} className={`px-3 py-2 text-sm ${p.id === activeProject ? 'bg-amber-50/60' : ''}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0">
                    <span className="font-mono text-xs text-gray-500 mr-2">{p.id}</span>
                    <span className="font-medium text-gray-900">{p.name}</span>
                    {p.id === activeProject && (
                      <span className="ml-2 text-[10px] uppercase tracking-wide text-amber-700">active</span>
                    )}
                    {p.client && <span className="block text-xs text-gray-400">{p.client}</span>}
                  </span>
                  <span className="flex items-center gap-1">
                    {p.id !== activeProject && (
                      <button
                        onClick={() => setActiveProject(p.id)}
                        className="text-xs text-gray-500 hover:text-amber-700 hover:bg-amber-50 rounded px-2 py-1"
                        aria-label={`Switch to ${p.id}`}
                      >
                        Open
                      </button>
                    )}
                    <button
                      onClick={() => deleteProject(p.id)}
                      className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded"
                      aria-label={`Remove ${p.id}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <label className="text-[11px] text-gray-500">
                    Contract value
                    <input
                      type="number"
                      min={0}
                      step="any"
                      className="mt-0.5 w-full border border-gray-200 rounded px-2 py-1 text-xs"
                      value={p.contractValue ?? 0}
                      onChange={(e) => updateProject(p.id, { contractValue: Number(e.target.value) || 0 })}
                      aria-label={`Contract value ${p.id}`}
                    />
                  </label>
                  <label className="text-[11px] text-gray-500">
                    Est. cost at completion
                    <input
                      type="number"
                      min={0}
                      step="any"
                      className="mt-0.5 w-full border border-gray-200 rounded px-2 py-1 text-xs"
                      value={p.estimatedCost ?? 0}
                      onChange={(e) => updateProject(p.id, { estimatedCost: Number(e.target.value) || 0 })}
                      aria-label={`Estimated cost ${p.id}`}
                    />
                  </label>
                </div>
              </li>
            ))}
          </ul>
        </div>

      <div className="bg-white rounded-xl border p-6">
        <h2 className="text-lg font-bold mb-1">Company details (letterhead)</h2>
        <p className="text-xs text-gray-500 mb-1">
          Printed on every bill, invoice, debit note and voucher.
        </p>
        <p className="text-xs text-amber-700 mb-4">
          This letterhead applies to job <span className="font-mono font-semibold">{activeProject}</span> only — open another job to edit that company's letterhead.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="text-[11px] text-gray-500">
            Firm name
            <input
              className="mt-0.5 w-full border border-gray-200 rounded px-2 py-1.5 text-sm text-gray-900"
              value={company.name}
              onChange={(e) => updateCompany({ name: e.target.value })}
              aria-label="Company name"
              placeholder="Registered firm name"
            />
          </label>
          <label className="text-[11px] text-gray-500">
            PAN
            <input
              className="mt-0.5 w-full border border-gray-200 rounded px-2 py-1.5 text-sm text-gray-900 font-mono"
              value={company.pan}
              onChange={(e) => updateCompany({ pan: e.target.value })}
              aria-label="Company PAN"
              placeholder="9-digit PAN"
            />
          </label>
          <label className="text-[11px] text-gray-500">
            VAT registration no.
            <input
              className="mt-0.5 w-full border border-gray-200 rounded px-2 py-1.5 text-sm text-gray-900 font-mono"
              value={company.vatNo}
              onChange={(e) => updateCompany({ vatNo: e.target.value })}
              aria-label="Company VAT number"
              placeholder="VAT number (if registered)"
            />
          </label>
          <label className="text-[11px] text-gray-500">
            Phone
            <input
              className="mt-0.5 w-full border border-gray-200 rounded px-2 py-1.5 text-sm text-gray-900"
              value={company.phone}
              onChange={(e) => updateCompany({ phone: e.target.value })}
              aria-label="Company phone"
            />
          </label>
          <label className="text-[11px] text-gray-500 sm:col-span-2">
            Address
            <input
              className="mt-0.5 w-full border border-gray-200 rounded px-2 py-1.5 text-sm text-gray-900"
              value={company.address}
              onChange={(e) => updateCompany({ address: e.target.value })}
              aria-label="Company address"
              placeholder="Street, city, district"
            />
          </label>
          <label className="text-[11px] text-gray-500">
            Email
            <input
              className="mt-0.5 w-full border border-gray-200 rounded px-2 py-1.5 text-sm text-gray-900"
              value={company.email}
              onChange={(e) => updateCompany({ email: e.target.value })}
              aria-label="Company email"
            />
          </label>
          <label className="text-[11px] text-gray-500">
            Footer note
            <input
              className="mt-0.5 w-full border border-gray-200 rounded px-2 py-1.5 text-sm text-gray-900"
              value={company.footer}
              onChange={(e) => updateCompany({ footer: e.target.value })}
              aria-label="Company footer"
              placeholder="Subject to local jurisdiction"
            />
          </label>
        </div>
        <div className="flex items-center gap-3 mt-3">
          <label className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-lg px-3 py-1.5 cursor-pointer">
            Upload logo
            <input type="file" accept="image/*" className="hidden" data-testid="logo-file" onChange={(e) => pickLogo(e.target.files?.[0] || null)} />
          </label>
          {company.logo && (
            <>
              <img src={company.logo} alt="logo" className="h-9 w-9 object-contain border border-gray-200 rounded" />
              <button type="button" onClick={() => updateCompany({ logo: '' })} className="text-xs text-gray-500 hover:text-red-600">
                Remove
              </button>
            </>
          )}
          <span className="text-[11px] text-gray-400">Stored offline; printed on every document.</span>
        </div>
        {companyNote && (
          <p className="mt-2 text-[11px] text-rose-700" role="alert">
            {companyNote}
          </p>
        )}
        {!(company.name.trim() && company.pan.trim()) && (
          <p className="mt-3 text-[11px] text-amber-700">
            Name and PAN are still missing — printed documents will show a placeholder.
          </p>
        )}
      </div>

        </div>

        {/* Cost-code master */}
        <div className="bg-white rounded-xl border p-6">
          <h2 className="text-lg font-bold mb-1">Cost codes</h2>
          <p className="text-xs text-gray-500 mb-4">Job costing rolls costs up by these codes; tag BOQ items to give them budgets.</p>

          <div className="grid grid-cols-3 gap-2 mb-3">
            <input
              className="border rounded-lg px-2.5 py-2 text-sm font-mono"
              placeholder="1600"
              value={newCode.code}
              onChange={(e) => setNewCode({ ...newCode, code: e.target.value })}
              aria-label="New cost code number"
            />
            <input
              className="border rounded-lg px-2.5 py-2 text-sm col-span-2"
              placeholder="Cost code name"
              value={newCode.name}
              onChange={(e) => setNewCode({ ...newCode, name: e.target.value })}
              aria-label="New cost code name"
            />
          </div>
          <button
            onClick={addCode}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded-lg px-3 py-1.5 mb-4"
          >
            <Plus className="w-4 h-4" /> Add cost code
          </button>

          <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden max-h-72 overflow-y-auto">
            {codes.map((c) => (
              <li key={c.code} className="flex items-center justify-between px-3 py-2 text-sm">
                <span>
                  <span className="font-mono text-xs text-gray-500 mr-2">{c.code}</span>
                  <span className="font-medium text-gray-900">{c.name}</span>
                  <span className="ml-2 text-[11px] uppercase text-gray-400">{c.kind}</span>
                </span>
                <button
                  onClick={() => deleteCode(c.code)}
                  className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded"
                  aria-label={`Remove cost code ${c.code}`}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
