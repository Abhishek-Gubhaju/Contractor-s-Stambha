import React from 'react';
import { CheckCircle2, Clock, AlertTriangle } from 'lucide-react';
import type { Reconciliation } from '../services/booksService';

/**
 * D3 reconciliation indicator — rendered on BOTH the Main Ledger and the
 * Labour Ledger, fed by the same labourService.reconcile() computation:
 *   green  = Σ ledger cash out (category Labour) == Σ advances + Σ payroll posted, nothing pending
 *   amber  = matched but payroll runs are still draft/approved (pending Pay)
 *   red    = mismatch, difference shown
 */
export default function ReconciliationBadge({
  rec,
  onClick,
}: {
  rec: Reconciliation;
  onClick?: () => void;
}) {
  const cfg = {
    green: {
      cls: 'bg-green-50 text-green-700 border-green-200',
      icon: <CheckCircle2 className="w-4 h-4" />,
      label: 'Reconciled',
      detail: `Labour out ${rec.ledgerOut.toLocaleString()} = posted ${rec.labourSide.toLocaleString()}`,
    },
    amber: {
      cls: 'bg-amber-50 text-amber-800 border-amber-200',
      icon: <Clock className="w-4 h-4" />,
      label: 'Reconciliation pending',
      detail: `Matched ${rec.labourSide.toLocaleString()} — payroll awaiting payment`,
    },
    red: {
      cls: 'bg-red-50 text-red-700 border-red-200',
      icon: <AlertTriangle className="w-4 h-4" />,
      label: `Reconciliation mismatch (Δ ${rec.difference.toLocaleString()})`,
      detail: `Ledger ${rec.ledgerOut.toLocaleString()} vs posted ${rec.labourSide.toLocaleString()}`,
    },
  }[rec.status];

  return (
    <button
      type="button"
      onClick={onClick}
      title={cfg.detail}
      data-testid="reconciliation-badge"
      data-status={rec.status}
      className={`inline-flex items-center gap-1.5 border rounded-lg px-3 py-1.5 text-xs font-medium ${cfg.cls}`}
    >
      {cfg.icon}
      {cfg.label}
    </button>
  );
}
