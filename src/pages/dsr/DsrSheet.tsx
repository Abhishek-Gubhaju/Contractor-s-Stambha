// ============================================================================
// DsrSheet — the A4 Daily Site Report a contractor signs and files.
//
// Prints exactly what the ledger-adjacent pages count: every work item with
// today's quantity, the running total before it and after it, labour by trade,
// plant hours vs idle, materials received/used with challan numbers, quality
// tests with results, lost time with reasons, and safety.
//
// The sheet is derived from the stored report only — no re-typing, no second
// source of truth — and it is itself the print source (printService clones it).
// ============================================================================
import { formatBS } from '../../utils/nepaliDate';
import { loadCompany } from '../../services/companyService';
import { projectNameOf } from '../../services/masterData';
import {
  WEATHER_LABEL,
  SHIFT_LABEL,
  cumulativeBefore,
  delayHours,
  labourCount,
  labourHours,
  plantHours,
  plantIdleHours,
  round2,
  type DsrReport,
} from '../../services/dsrService';

interface DsrSheetProps {
  report: DsrReport;
  /** All reports of the project — needed for the "previous / cumulative" columns. */
  allReports: DsrReport[];
  boq?: { itemCode: string; quantity: number; rate: number; unit: string }[];
}

export function DsrSheet({ report, allReports, boq = [] }: DsrSheetProps) {
  const company = loadCompany();
  const boqByCode = new Map(boq.map((b) => [b.itemCode.trim().toLowerCase(), b]));
  const items = report.items || [];
  const statusLabel = report.status === 'approved' ? 'APPROVED' : report.status === 'submitted' ? 'SUBMITTED' : 'DRAFT';

  return (
    <div className="bg-white text-gray-900 border border-gray-200 rounded-lg p-6 text-[11px]" data-testid="dsr-sheet">
      {/* Letterhead */}
      <div className="flex items-start justify-between border-b-2 border-gray-800 pb-2">
        <div className="flex items-start gap-2">
          {company.logo && <img src={company.logo} alt="" className="h-10 w-10 object-contain" />}
          <div>
            <p className="text-base font-bold leading-tight">{company.name || 'Your company name'}</p>
            <p className="text-gray-600">{company.address}</p>
            <p className="text-gray-600">
              {company.pan && <>PAN: {company.pan}</>}
              {company.pan && company.vatNo && ' · '}
              {company.vatNo && <>VAT: {company.vatNo}</>}
            </p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-sm font-bold tracking-wide">DAILY SITE REPORT</p>
          <p className="text-gray-600">दैनिक साइट प्रतिवेदन</p>
          <p className="mt-1">
            No: <span className="font-mono font-semibold">{report.reportNo || '—'}</span>
          </p>
          <p>Date (B.S.): {formatBS({ year: report.bs_y, month: report.bs_m, day: report.bs_d })}</p>
          <p>Date (A.D.): {report.date}</p>
          <p className={`font-semibold ${report.status === 'approved' ? 'text-emerald-700' : 'text-gray-700'}`}>{statusLabel}</p>
        </div>
      </div>

      {/* Header facts */}
      <div className="grid grid-cols-4 gap-2 border-b border-gray-300 py-2">
        <div>
          <p className="text-[9px] uppercase text-gray-500">Job</p>
          <p className="font-semibold">{report.project_id || '—'} · {projectNameOf(report.project_id)}</p>
        </div>
        <div>
          <p className="text-[9px] uppercase text-gray-500">Weather</p>
          <p className="font-semibold">{WEATHER_LABEL[report.weather] || report.weather}</p>
        </div>
        <div>
          <p className="text-[9px] uppercase text-gray-500">Shift</p>
          <p className="font-semibold">{SHIFT_LABEL[report.shift] || report.shift}</p>
        </div>
        <div>
          <p className="text-[9px] uppercase text-gray-500">Labour on site</p>
          <p className="font-semibold">{labourCount(report)} men · {labourHours(report)} hours</p>
        </div>
      </div>

      {/* Work done */}
      <p className="mt-2 font-semibold text-[10px] uppercase tracking-wide">Work done</p>
      <table className="w-full border-collapse mt-1">
        <thead>
          <tr className="bg-gray-50 border-y border-gray-300">
            <th className="px-1 py-1 text-left w-7">SN</th>
            <th className="px-1 py-1 text-left">BOQ item / description</th>
            <th className="px-1 py-1 text-left w-20">Location</th>
            <th className="px-1 py-1 text-right w-16">Qty</th>
            <th className="px-1 py-1 text-left w-10">Unit</th>
            <th className="px-1 py-1 text-right w-20">Previous</th>
            <th className="px-1 py-1 text-right w-20">Cumulative</th>
            <th className="px-1 py-1 text-right w-20">BOQ qty</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => {
            // `before` counts reports on strictly earlier dates, so this
            // report's own line is added exactly once — editing it can never
            // double-count.
            const before = cumulativeBefore(allReports, it.boqCode, report.date);
            const after = round2(before + (Number(it.quantity) || 0));
            const boqItem = boqByCode.get(it.boqCode.trim().toLowerCase());
            return (
              <tr key={it.id} className="border-b border-gray-100 align-top">
                <td className="px-1 py-1">{i + 1}</td>
                <td className="px-1 py-1">
                  <span className="font-mono">{it.boqCode}</span>
                  {it.description ? <> — {it.description}</> : null}
                  {it.remark ? <span className="block text-gray-500">{it.remark}</span> : null}
                </td>
                <td className="px-1 py-1">{it.location || '—'}</td>
                <td className="px-1 py-1 text-right tabular-nums font-semibold">{it.quantity || '—'}</td>
                <td className="px-1 py-1">{it.unit || '—'}</td>
                <td className="px-1 py-1 text-right tabular-nums">{before || '—'}</td>
                <td className="px-1 py-1 text-right tabular-nums font-semibold">{after || '—'}</td>
                <td className="px-1 py-1 text-right tabular-nums">{boqItem?.quantity || '—'}</td>
              </tr>
            );
          })}
          {items.length === 0 && (
            <tr>
              <td colSpan={8} className="px-1 py-3 text-center text-gray-400">No work item recorded.</td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="grid grid-cols-2 gap-4 mt-3">
        {/* Labour */}
        <div>
          <p className="font-semibold text-[10px] uppercase tracking-wide">Labour</p>
          <table className="w-full border-collapse mt-1">
            <thead>
              <tr className="bg-gray-50 border-y border-gray-300">
                <th className="px-1 py-1 text-left">Trade</th>
                <th className="px-1 py-1 text-right w-12">Nos</th>
                <th className="px-1 py-1 text-right w-14">Hrs</th>
                <th className="px-1 py-1 text-right w-14">OT</th>
              </tr>
            </thead>
            <tbody>
              {(report.labour || []).map((r) => (
                <tr key={r.id} className="border-b border-gray-100">
                  <td className="px-1 py-1">{r.trade || '—'}</td>
                  <td className="px-1 py-1 text-right tabular-nums">{r.count}</td>
                  <td className="px-1 py-1 text-right tabular-nums">{r.hours}</td>
                  <td className="px-1 py-1 text-right tabular-nums">{r.overtimeHours || '—'}</td>
                </tr>
              ))}
              {(report.labour || []).length === 0 && (
                <tr><td colSpan={4} className="px-1 py-2 text-center text-gray-400">No labour recorded.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Plant */}
        <div>
          <p className="font-semibold text-[10px] uppercase tracking-wide">Plant &amp; equipment</p>
          <table className="w-full border-collapse mt-1">
            <thead>
              <tr className="bg-gray-50 border-y border-gray-300">
                <th className="px-1 py-1 text-left">Machine</th>
                <th className="px-1 py-1 text-right w-14">Worked</th>
                <th className="px-1 py-1 text-right w-14">Idle</th>
                <th className="px-1 py-1 text-left w-24">Note</th>
              </tr>
            </thead>
            <tbody>
              {(report.plant || []).map((p) => (
                <tr key={p.id} className="border-b border-gray-100">
                  <td className="px-1 py-1">{p.name || '—'}</td>
                  <td className="px-1 py-1 text-right tabular-nums">{p.hours || '—'}</td>
                  <td className="px-1 py-1 text-right tabular-nums">{p.idleHours || '—'}</td>
                  <td className="px-1 py-1 text-gray-600">{p.note}</td>
                </tr>
              ))}
              {(report.plant || []).length === 0 && (
                <tr><td colSpan={4} className="px-1 py-2 text-center text-gray-400">No plant recorded.</td></tr>
              )}
            </tbody>
          </table>
          <p className="mt-1 text-[10px] text-gray-500">
            Worked {plantHours(report)} h · idle {plantIdleHours(report)} h
          </p>
        </div>
      </div>

      {/* Materials + tests */}
      <div className="grid grid-cols-2 gap-4 mt-3">
        <div>
          <p className="font-semibold text-[10px] uppercase tracking-wide">Materials at site</p>
          <table className="w-full border-collapse mt-1">
            <thead>
              <tr className="bg-gray-50 border-y border-gray-300">
                <th className="px-1 py-1 text-left">Material</th>
                <th className="px-1 py-1 text-right w-14">Received</th>
                <th className="px-1 py-1 text-right w-14">Used</th>
                <th className="px-1 py-1 text-left w-24">Challan</th>
              </tr>
            </thead>
            <tbody>
              {(report.materials || []).map((m) => (
                <tr key={m.id} className="border-b border-gray-100">
                  <td className="px-1 py-1">{m.name} {m.unit && <span className="text-gray-500">({m.unit})</span>}</td>
                  <td className="px-1 py-1 text-right tabular-nums">{m.received || '—'}</td>
                  <td className="px-1 py-1 text-right tabular-nums">{m.used || '—'}</td>
                  <td className="px-1 py-1">{m.challan || '—'}{m.supplier ? <span className="block text-gray-500">{m.supplier}</span> : null}</td>
                </tr>
              ))}
              {(report.materials || []).length === 0 && (
                <tr><td colSpan={4} className="px-1 py-2 text-center text-gray-400">No material movement.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div>
          <p className="font-semibold text-[10px] uppercase tracking-wide">Quality tests</p>
          <table className="w-full border-collapse mt-1">
            <thead>
              <tr className="bg-gray-50 border-y border-gray-300">
                <th className="px-1 py-1 text-left">Test</th>
                <th className="px-1 py-1 text-left w-20">At</th>
                <th className="px-1 py-1 text-left w-24">Result</th>
                <th className="px-1 py-1 text-center w-12">OK</th>
              </tr>
            </thead>
            <tbody>
              {(report.tests || []).map((t) => (
                <tr key={t.id} className="border-b border-gray-100">
                  <td className="px-1 py-1">{t.kind || '—'}</td>
                  <td className="px-1 py-1">{t.location || '—'}</td>
                  <td className="px-1 py-1">{t.result || '—'}</td>
                  <td className="px-1 py-1 text-center">{t.passed ? '✓' : '✗'}</td>
                </tr>
              ))}
              {(report.tests || []).length === 0 && (
                <tr><td colSpan={4} className="px-1 py-2 text-center text-gray-400">No test today.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Delays / safety */}
      <div className="grid grid-cols-2 gap-4 mt-3">
        <div>
          <p className="font-semibold text-[10px] uppercase tracking-wide">Lost time ({delayHours(report)} h)</p>
          {(report.delays || []).length === 0 ? (
            <p className="text-gray-500">None.</p>
          ) : (
            <ul className="list-disc pl-4">
              {report.delays.map((d) => (
                <li key={d.id}>{d.reason || 'Unspecified'} — {d.hours} h</li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="font-semibold text-[10px] uppercase tracking-wide">Safety</p>
          <p>Toolbox talk: {report.safety?.toolbox ? 'Yes' : 'No'} · PPE check: {report.safety?.ppe ? 'Yes' : 'No'}</p>
          <p>Incident: {report.safety?.incident || 'None reported'}</p>
          {report.safety?.notes && <p className="text-gray-600">{report.safety.notes}</p>}
        </div>
      </div>

      {/* Attachments — names only; the files themselves live in the Vault. */}
      <div className="mt-3 border-t border-gray-200 pt-1" data-testid="dsr-sheet-attachments">
        <p className="font-semibold text-[10px] uppercase tracking-wide">
          Attachments ({(report.attachments || []).length})
        </p>
        {(report.attachments || []).length === 0 ? (
          <p className="text-gray-500">No files attached.</p>
        ) : (
          <ol className="list-decimal pl-4 space-y-0.5">
            {report.attachments.map((row) => (
              <li key={row.id} className="break-words">
                {row.name}
                {row.ext ? <span className="text-gray-500"> (.{row.ext})</span> : null}
              </li>
            ))}
          </ol>
        )}
        <p className="mt-1 text-[9px] text-gray-500 break-words">
          Filed in File Vault › Daily Site Reports › {String(report.date).slice(0, 7)} › {report.date}
        </p>
      </div>

      {(report.instructions || report.visitors || report.note) && (
        <div className="mt-3 border-t border-gray-200 pt-1">
          {report.instructions && <p><span className="font-semibold">Instructions:</span> {report.instructions}</p>}
          {report.visitors && <p><span className="font-semibold">Visitors:</span> {report.visitors}</p>}
          {report.note && <p><span className="font-semibold">Remarks:</span> {report.note}</p>}
        </div>
      )}

      <div className="grid grid-cols-3 gap-6 mt-8 text-center text-[10px]">
        <div>
          <div className="border-t border-gray-400 pt-1">Prepared by{report.preparedBy ? ` — ${report.preparedBy}` : ''} (Site supervisor)</div>
        </div>
        <div>
          <div className="border-t border-gray-400 pt-1">Checked by{report.checkedBy ? ` — ${report.checkedBy}` : ''} (Site engineer)</div>
        </div>
        <div>
          <div className="border-t border-gray-400 pt-1">Approved by (Project manager)</div>
        </div>
      </div>
      <p className="mt-2 text-[9px] text-center text-gray-400">
        {company.footer || `Daily site report ${report.reportNo || ''} · ${report.date}`} · Quantities as measured on site
      </p>
    </div>
  );
}

export default DsrSheet;
