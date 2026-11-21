// Controls bar (S4.6) — period selector (local month + AD range + fiscal-year
// chip), lock state, opening balances per account, CSV/PDF export, backup
// nudge, migration-parity status and reconciliation chips.
// Trial balance RED blocks exports and shows a banner (S6.3).
import { useState } from 'react';
import { Lock, Unlock, FileDown, Printer, ShieldCheck, ChevronLeft, ChevronRight, HardDriveDownload } from 'lucide-react';
import { cn, formatCurrency } from '../../utils';
import { BS_MONTHS } from '../../utils/nepaliDate';
import { type BSPeriod, fiscalYearOf, periodAdRange, periodKey, prevPeriod, nextPeriod } from '../../services/periods';
import {
  isPeriodLocked, lockPeriod, unlockPeriod, getAudit,
  openingBalance, trialBalance, labourChip, billingChip, loadMeta,
} from '../../services/booksService';
import { labourTotalsForReconciliation } from '../../services/labourService';
import { downloadCsv } from '../../services/booksService';
import { downloadBackup, checkBackupNudge } from '../../services/ledgerService';
import { migrationStatus } from '../../services/ledgerMigration';
import { printCurrentTarget } from '../../services/print/printService';

const chipCls = 'inline-flex items-center gap-1.5 border rounded-lg px-2.5 py-1 text-xs font-medium';

function statusChipCls(status: 'green' | 'amber' | 'red') {
  return status === 'green'
    ? `${chipCls} bg-emerald-50 text-emerald-700 border-emerald-200`
    : status === 'amber'
      ? `${chipCls} bg-amber-50 text-amber-800 border-amber-200`
      : `${chipCls} bg-red-50 text-red-700 border-red-200`;
}

export default function ControlsBar({
  period,
  setPeriod,
  version,
}: {
  period: BSPeriod;
  setPeriod: (p: BSPeriod) => void;
  version: number;
}) {
  void version;
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState('');
  const locked = isPeriodLocked(period.year, period.month);
  const range = periodAdRange(period);
  const fy = fiscalYearOf(period.year, period.month);
  const tb = trialBalance();
  const parity = migrationStatus();
  const labour = labourChip(labourTotalsForReconciliation());
  const billing = billingChip();
  const nudge = checkBackupNudge(period);
  const meta = loadMeta();
  const lastUnlock = [...meta.audit].reverse().find((a) => a.action === 'unlock');

  const applyLock = (action: 'lock' | 'unlock') => {
    try {
      if (action === 'lock') lockPeriod(period.year, period.month, reason);
      else unlockPeriod(period.year, period.month, reason);
      setMsg(`${action === 'lock' ? 'Locked' : 'Unlocked'} ${periodKey(period.year, period.month)} — reason logged in audit.`);
      setReason('');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-2">
      {!tb.balanced && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-red-300 bg-red-50 text-xs text-red-700" data-testid="tb-export-block" role="alert">
          Trial balance is red — CSV/PDF exports are blocked until Σ Dr = Σ Cr.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {/* period selector: local month + AD range + fiscal-year chip */}
        <div className="inline-flex items-center border border-gray-200 rounded-lg bg-white overflow-hidden">
          <button className="px-2 py-1.5 hover:bg-gray-50" aria-label="Previous month" onClick={() => setPeriod(prevPeriod(period))}>
            <ChevronLeft className="w-4 h-4 text-gray-500" />
          </button>
          <span className="px-2 text-sm font-medium text-gray-900" data-testid="period-label">
            {BS_MONTHS[period.month - 1]} {period.year}
          </span>
          <button className="px-2 py-1.5 hover:bg-gray-50" aria-label="Next month" onClick={() => setPeriod(nextPeriod(period))}>
            <ChevronRight className="w-4 h-4 text-gray-500" />
          </button>
        </div>
        <span className="text-xs text-gray-500" data-testid="period-ad-range">AD {range.from} → {range.to}</span>
        <span className="text-[11px] font-medium bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-full px-2.5 py-1" data-testid="fy-chip">FY {fy.label}</span>

        {/* lock state */}
        <span className={cn(chipCls, locked ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-gray-50 text-gray-600 border-gray-200')} data-testid="lock-state" data-locked={String(locked)}>
          {locked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
          {locked ? 'Locked' : 'Unlocked'}
        </span>
        <input
          className="border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs bg-white w-44"
          placeholder="Reason (required)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          data-testid="lock-reason"
          aria-label="Lock/unlock reason"
        />
        <button
          className={cn(chipCls, 'hover:bg-gray-100')}
          data-testid={locked ? 'unlock-button' : 'lock-button'}
          disabled={!reason.trim()}
          onClick={() => applyLock(locked ? 'unlock' : 'lock')}
        >
          {locked ? 'Unlock period' : 'Lock period'}
        </button>

        <span className="flex-1" />

        {/* opening balances per account */}
        <span className="text-xs text-gray-500" data-testid="openings">
          Opening — cash <b className="text-gray-800 tabular-nums">{formatCurrency(openingBalance('cash', period))}</b> · bank <b className="text-gray-800 tabular-nums">{formatCurrency(openingBalance('bank', period))}</b>
        </span>

        {/* exports (blocked when trial balance red) */}
        <button
          className={cn(chipCls, 'bg-white hover:bg-gray-50', !tb.balanced && 'opacity-40 cursor-not-allowed')}
          disabled={!tb.balanced}
          data-testid="export-csv"
          onClick={() => downloadCsv(`ledger_${fy.label.replace('/', '-')}_${periodKey(period.year, period.month)}.csv`)}
        >
          <FileDown className="w-3.5 h-3.5" /> CSV
        </button>
        <button
          className={cn(chipCls, 'bg-white hover:bg-gray-50', !tb.balanced && 'opacity-40 cursor-not-allowed')}
          disabled={!tb.balanced}
          data-testid="export-pdf"
          onClick={() => void printCurrentTarget()}
        >
          <Printer className="w-3.5 h-3.5" /> PDF
        </button>

        {/* backup nudge */}
        <button className={cn(chipCls, nudge ? 'bg-amber-50 text-amber-800 border-amber-300' : 'bg-white hover:bg-gray-50')} data-testid="backup-button" onClick={() => downloadBackup()}>
          <HardDriveDownload className="w-3.5 h-3.5" /> {nudge ? 'Backup due' : 'Backup'}
        </button>

        {/* migration parity */}
        <span className={statusChipCls(parity.green ? 'green' : 'red')} data-testid="parity-chip" data-green={String(parity.green)}>
          <ShieldCheck className="w-3.5 h-3.5" />
          {parity.migrated ? `Migration parity ${parity.green ? 'green' : 'RED'}` : parity.green ? 'Legacy parity green' : 'Parity red'}
        </span>

        {/* reconciliation chips */}
        <span className={statusChipCls(labour.status)} data-testid="chip-labour" data-status={labour.status} title={labour.detail}>
          {labour.label}
        </span>
        <span className={statusChipCls(billing.status)} data-testid="chip-billing" data-status={billing.status} title={billing.detail}>
          {billing.label}
        </span>
      </div>

      {(msg || lastUnlock) && (
        <p className="text-xs text-gray-500" data-testid="lock-msg">
          {msg || `Last unlock: ${lastUnlock?.reason || ''} (${lastUnlock?.at ? new Date(lastUnlock.at).toLocaleString() : ''})`}
        </p>
      )}
      <p className="text-[11px] text-gray-400">Audit entries: {getAudit().length} · {meta.migrated_at ? `migrated ${new Date(meta.migrated_at).toLocaleString()}` : 'legacy migration pending'}</p>
    </div>
  );
}
