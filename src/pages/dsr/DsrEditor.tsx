// ============================================================================
// DsrEditor — the daily report form, section by section.
//
// Sections mirror the printed sheet: Work · Labour · Plant · Materials · Tests
// · Site (weather, delays, safety, instructions). Each row is addable and
// removable; totals (men, hours, idle, lost time) update as you type.
//
// Work quantities are checked against the BOQ: the row shows the running total
// before today and what it becomes, and the validator warns when a job would be
// reported beyond its contract quantity — the commonest DSR error there is.
// ============================================================================
import { useMemo, useState } from 'react';
import { Plus, Trash2, Users, AlertTriangle, X } from 'lucide-react';
import { Modal } from '../../components/ui';
import { STANDARD_WORK_HOURS } from '../../utils';
import {
  WEATHER_LABEL,
  SHIFT_LABEL,
  blankWorkItem,
  blankLabourRow,
  blankPlantRow,
  blankMaterialRow,
  blankTestRow,
  blankDelayRow,
  cumulativeBefore,
  labourCount,
  labourHours,
  delayHours,
  plantHours,
  plantIdleHours,
  round2,
  type DsrAttachment,
  type DsrReport,
  type DsrWorkItem,
  type DsrWeather,
  type DsrShift,
  type BoqRef,
} from '../../services/dsrService';
import { DsrAttachments } from './DsrAttachments';

interface DsrEditorProps {
  report: DsrReport | null;
  onChange: (report: DsrReport) => void;
  onClose: () => void;
  onSave: (status: 'draft' | 'submitted' | 'approved') => void;
  existing: DsrReport[];
  boq: BoqRef[];
  attendance: any[];
  errors: string[];
  warnings: string[];
  /** A save (including moving linked files) is in progress. */
  saving?: boolean;
  onAttach: (rows: DsrAttachment[]) => void;
  onDetach: (id: string) => void;
  onOpenInVault: (docId: string) => void;
}

/** Replace one row of a section by id — every editable table uses this. */
function patchRow<T extends { id: string }>(rows: T[], id: string, patch: Partial<T>): T[] {
  return rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
}

const cell =
  'w-full border border-gray-200 rounded px-2 py-1 text-xs bg-white focus:ring-1 focus:ring-blue-500 focus:border-blue-500';
const labelCls = 'block text-[11px] font-medium text-gray-600 mb-1';

const TRADES = [
  'Mason', 'Carpenter', 'Bar bender', 'Steel fixer', 'Plumber', 'Electrician',
  'Painter', 'Helper', 'Site labour', 'Machine operator', 'Driver', 'Supervisor',
];
const PLANT = [
  'Excavator', 'Backhoe loader', 'Dozer', 'Grader', 'Vibratory roller', 'Tipper',
  'Concrete mixer', 'Batching plant', 'Transit mixer', 'Water tanker',
  'Air compressor', 'Generator', 'Concrete pump', 'Vibrator',
];
const TESTS = [
  'Concrete cube — 7 day', 'Concrete cube — 28 day', 'Slump test', 'Compaction test',
  'Sieve analysis', 'CBR test', 'Bitumen extraction', 'Water/cement ratio', 'Level / alignment check',
];

type Section = 'work' | 'labour' | 'plant' | 'materials' | 'tests' | 'site' | 'files';

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'work', label: 'Work done' },
  { key: 'labour', label: 'Labour' },
  { key: 'plant', label: 'Plant' },
  { key: 'materials', label: 'Materials' },
  { key: 'tests', label: 'Tests' },
  { key: 'site', label: 'Site & safety' },
  { key: 'files', label: 'Photos & files' },
];

export function DsrEditor(props: DsrEditorProps) {
  const {
    report, onChange, onClose, onSave, existing, boq, attendance, errors, warnings,
    saving = false, onAttach, onDetach, onOpenInVault,
  } = props;
  const [section, setSection] = useState<Section>('work');

  const boqByCode = useMemo(() => new Map((boq || []).map((b) => [b.itemCode.trim().toLowerCase(), b])), [boq]);
  if (!report) return null;
  const locked = report.status === 'approved';
  const set = (patch: Partial<DsrReport>) => onChange({ ...report, ...patch });

  const updateItem = (id: string, patch: Partial<DsrWorkItem>) => {
    set({
      items: report.items.map((it) => {
        if (it.id !== id) return it;
        const next = { ...it, ...patch };
        // Picking a BOQ code fills the description and unit from the contract.
        if ('boqCode' in patch) {
          const match = boqByCode.get(String(next.boqCode || '').trim().toLowerCase());
          if (match) {
            next.description = next.description || match.description;
            next.unit = match.unit || next.unit;
          }
        }
        return next;
      }),
    });
  };

  const addItem = () => set({ items: [...report.items, blankWorkItem()] });
  const removeItem = (id: string) => set({ items: report.items.filter((i) => i.id !== id) });

  const pullAttendance = () => {
    const byTrade = new Map<string, number>();
    for (const row of attendance || []) {
      if (row?.status !== 'present') continue;
      const trade = String(row.trade || row.designation || 'Site labour').trim() || 'Site labour';
      byTrade.set(trade, (byTrade.get(trade) || 0) + 1);
    }
    const rows = [...byTrade.entries()].map(([trade, count]) => ({
      ...blankLabourRow(),
      trade,
      count,
      hours: STANDARD_WORK_HOURS,
    }));
    if (rows.length === 0) return;
    set({ labour: rows });
  };

  const siteField = (label: string, node: React.ReactNode) => (
    <div>
      <label className={labelCls}>{label}</label>
      {node}
    </div>
  );

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="full"
      title={`Daily Site Report${report.reportNo ? ` · ${report.reportNo}` : ''}`}
      description={`${report.date} · ${report.status}`}
    >
      <div className="space-y-3">
        {/* Header line */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div>
            <label className={labelCls}>Date (A.D.)</label>
            <input
              type="date"
              className={`${cell} text-sm`}
              value={report.date}
              onChange={(e) => set({ date: e.target.value })}
              aria-label="Report date"
              disabled={locked}
            />
          </div>
          <div>
            <label className={labelCls}>Weather</label>
            <select className={`${cell} text-sm`} value={report.weather} onChange={(e) => set({ weather: e.target.value as DsrWeather })} aria-label="Weather" disabled={locked}>
              {Object.entries(WEATHER_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Shift</label>
            <select className={`${cell} text-sm`} value={report.shift} onChange={(e) => set({ shift: e.target.value as DsrShift })} aria-label="Shift" disabled={locked}>
              {Object.entries(SHIFT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Prepared by</label>
            <input className={`${cell} text-sm`} value={report.preparedBy} onChange={(e) => set({ preparedBy: e.target.value })} aria-label="Prepared by" disabled={locked} />
          </div>
          <div>
            <label className={labelCls}>Checked by</label>
            <input className={`${cell} text-sm`} value={report.checkedBy} onChange={(e) => set({ checkedBy: e.target.value })} aria-label="Checked by" disabled={locked} />
          </div>
        </div>

        {/* Section tabs */}
        <div className="flex flex-wrap gap-1 border-b border-gray-200">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setSection(s.key)}
              data-testid={`dsr-section-${s.key}`}
              className={`px-3 py-1.5 text-xs font-medium rounded-t ${section === s.key ? 'bg-amber-50 text-amber-800 border-b-2 border-gray-900' : 'text-gray-500 hover:text-gray-800'}`}
            >
              {s.label}
              {s.key === 'work' && report.items.length > 0 && <span className="ml-1 text-gray-400">({report.items.length})</span>}
              {s.key === 'labour' && <span className="ml-1 text-gray-400">({labourCount(report)})</span>}
              {s.key === 'files' && (report.attachments?.length ?? 0) > 0 && (
                <span className="ml-1 text-gray-400">({report.attachments.length})</span>
              )}
            </button>
          ))}
        </div>

        {/* WORK */}
        {section === 'work' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-500">One row per BOQ item worked on today. Location is the chainage / pier / floor.</p>
              <button type="button" onClick={addItem} className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded px-2 py-1" data-testid="dsr-add-work" disabled={locked}>
                <Plus className="w-3.5 h-3.5" /> Add item
              </button>
            </div>
            <div className="overflow-x-auto border border-gray-200 rounded-lg">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-gray-500">
                  <tr>
                    <th className="px-2 py-1.5 text-left w-7">#</th>
                    <th className="px-2 py-1.5 text-left w-28">BOQ code</th>
                    <th className="px-2 py-1.5 text-left min-w-[180px]">Description</th>
                    <th className="px-2 py-1.5 text-left w-32">Location</th>
                    <th className="px-2 py-1.5 text-right w-20">Qty today</th>
                    <th className="px-2 py-1.5 text-left w-16">Unit</th>
                    <th className="px-2 py-1.5 text-right w-24">Cumulative</th>
                    <th className="px-2 py-1.5 w-8"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {report.items.map((it, i) => {
                    const boqItem = boqByCode.get(String(it.boqCode).trim().toLowerCase());
                    // Other reports up to yesterday + this report's other lines.
                    const prior = cumulativeBefore(existing, it.boqCode, report.date);
                    const sameDayOther = report.items
                      .filter((x) => x.id !== it.id && String(x.boqCode).trim().toLowerCase() === String(it.boqCode).trim().toLowerCase())
                      .reduce((s, x) => s + (Number(x.quantity) || 0), 0);
                    const total = round2(prior + sameDayOther + (Number(it.quantity) || 0));
                    const over = boqItem && boqItem.quantity > 0 && total > boqItem.quantity + 0.005;
                    return (
                      <tr key={it.id} className="align-top">
                        <td className="px-2 py-1.5 text-gray-400">{i + 1}</td>
                        <td className="px-2 py-1.5">
                          <input className={cell} list="dsr-boq-codes" value={it.boqCode} onChange={(e) => updateItem(it.id, { boqCode: e.target.value })} aria-label={`Work item ${i + 1} BOQ code`} disabled={locked} />
                        </td>
                        <td className="px-2 py-1.5">
                          <input className={cell} value={it.description} onChange={(e) => updateItem(it.id, { description: e.target.value })} aria-label={`Work item ${i + 1} description`} disabled={locked} />
                        </td>
                        <td className="px-2 py-1.5">
                          <input className={cell} value={it.location} onChange={(e) => updateItem(it.id, { location: e.target.value })} placeholder="CH 0+250 / Pier 3" aria-label={`Work item ${i + 1} location`} disabled={locked} />
                        </td>
                        <td className="px-2 py-1.5">
                          <input type="number" step="any" className={`${cell} text-right tabular-nums`} value={it.quantity || ''} onChange={(e) => updateItem(it.id, { quantity: Number(e.target.value) || 0 })} aria-label={`Work item ${i + 1} quantity`} disabled={locked} />
                        </td>
                        <td className="px-2 py-1.5">
                          <input className={cell} value={it.unit} onChange={(e) => updateItem(it.id, { unit: e.target.value })} aria-label={`Work item ${i + 1} unit`} disabled={locked} />
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          <span className={over ? 'text-red-600 font-semibold' : 'text-gray-700'}>{total || '—'}</span>
                          {boqItem?.quantity ? <span className="block text-[10px] text-gray-400">of {boqItem.quantity}</span> : null}
                        </td>
                        <td className="px-2 py-1.5">
                          <button type="button" onClick={() => removeItem(it.id)} className="p-1 text-gray-400 hover:text-red-600" aria-label={`Remove work item ${i + 1}`} disabled={locked}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {report.items.length === 0 && (
                    <tr><td colSpan={8} className="px-3 py-4 text-center text-gray-400">No work item yet — add the first one.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <datalist id="dsr-boq-codes">
              {boq.map((b) => <option key={b.itemCode} value={b.itemCode}>{b.description}</option>)}
            </datalist>
            <input className={cell} value={report.note} onChange={(e) => set({ note: e.target.value })} placeholder="Remarks on the work (optional)" aria-label="Report remarks" disabled={locked} />
          </div>
        )}

        {/* LABOUR */}
        {section === 'labour' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-500">Headcount by trade. {labourCount(report)} men · {labourHours(report)} hours.</p>
              <div className="flex gap-2">
                <button type="button" onClick={pullAttendance} className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 rounded px-2 py-1" data-testid="dsr-pull-attendance">
                  <Users className="w-3.5 h-3.5" /> Pull attendance
                </button>
                <button type="button" onClick={() => set({ labour: [...report.labour, blankLabourRow()] })} className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded px-2 py-1" data-testid="dsr-add-labour" disabled={locked}>
                  <Plus className="w-3.5 h-3.5" /> Add trade
                </button>
              </div>
            </div>
            <div className="overflow-x-auto border border-gray-200 rounded-lg">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-gray-500">
                  <tr>
                    <th className="px-2 py-1.5 text-left">Trade</th>
                    <th className="px-2 py-1.5 text-right w-20">Nos</th>
                    <th className="px-2 py-1.5 text-right w-20">Hours</th>
                    <th className="px-2 py-1.5 text-right w-20">OT hrs</th>
                    <th className="px-2 py-1.5 w-8"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {report.labour.map((r, i) => (
                    <tr key={r.id}>
                      <td className="px-2 py-1.5">
                        <input className={cell} list="dsr-trades" value={r.trade} onChange={(e) => set({ labour: patchRow(report.labour, r.id, { trade: e.target.value }) })} aria-label={`Labour ${i + 1} trade`} disabled={locked} />
                      </td>
                      <td className="px-2 py-1.5">
                        <input type="number" className={`${cell} text-right`} value={r.count || ''} onChange={(e) => set({ labour: patchRow(report.labour, r.id, { count: Number(e.target.value) || 0 }) })} aria-label={`Labour ${i + 1} count`} disabled={locked} />
                      </td>
                      <td className="px-2 py-1.5">
                        <input type="number" step="any" className={`${cell} text-right`} value={r.hours || ''} onChange={(e) => set({ labour: patchRow(report.labour, r.id, { hours: Number(e.target.value) || 0 }) })} aria-label={`Labour ${i + 1} hours`} disabled={locked} />
                      </td>
                      <td className="px-2 py-1.5">
                        <input type="number" step="any" className={`${cell} text-right`} value={r.overtimeHours || ''} onChange={(e) => set({ labour: patchRow(report.labour, r.id, { overtimeHours: Number(e.target.value) || 0 }) })} aria-label={`Labour ${i + 1} overtime`} disabled={locked} />
                      </td>
                      <td className="px-2 py-1.5">
                        <button type="button" onClick={() => set({ labour: report.labour.filter((x) => x.id !== r.id) })} className="p-1 text-gray-400 hover:text-red-600" aria-label={`Remove labour ${i + 1}`} disabled={locked}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {report.labour.length === 0 && (
                    <tr><td colSpan={5} className="px-3 py-4 text-center text-gray-400">No labour recorded — pull today's attendance or add a trade.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <datalist id="dsr-trades">{TRADES.map((t) => <option key={t} value={t} />)}</datalist>
          </div>
        )}

        {/* PLANT */}
        {section === 'plant' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-500">Machinery on site. Worked {plantHours(report)} h · idle {plantIdleHours(report)} h.</p>
              <button type="button" onClick={() => set({ plant: [...report.plant, blankPlantRow()] })} className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded px-2 py-1" data-testid="dsr-add-plant" disabled={locked}>
                <Plus className="w-3.5 h-3.5" /> Add machine
              </button>
            </div>
            <div className="overflow-x-auto border border-gray-200 rounded-lg">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-gray-500">
                  <tr>
                    <th className="px-2 py-1.5 text-left">Equipment</th>
                    <th className="px-2 py-1.5 text-right w-20">Worked h</th>
                    <th className="px-2 py-1.5 text-right w-20">Idle h</th>
                    <th className="px-2 py-1.5 text-left w-48">Note (breakdown / fuel)</th>
                    <th className="px-2 py-1.5 w-8"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {report.plant.map((p, i) => (
                    <tr key={p.id}>
                      <td className="px-2 py-1.5">
                        <input className={cell} list="dsr-plant" value={p.name} onChange={(e) => set({ plant: patchRow(report.plant, p.id, { name: e.target.value }) })} aria-label={`Plant ${i + 1} name`} disabled={locked} />
                      </td>
                      <td className="px-2 py-1.5">
                        <input type="number" step="any" className={`${cell} text-right`} value={p.hours || ''} onChange={(e) => set({ plant: patchRow(report.plant, p.id, { hours: Number(e.target.value) || 0 }) })} aria-label={`Plant ${i + 1} hours`} disabled={locked} />
                      </td>
                      <td className="px-2 py-1.5">
                        <input type="number" step="any" className={`${cell} text-right`} value={p.idleHours || ''} onChange={(e) => set({ plant: patchRow(report.plant, p.id, { idleHours: Number(e.target.value) || 0 }) })} aria-label={`Plant ${i + 1} idle hours`} disabled={locked} />
                      </td>
                      <td className="px-2 py-1.5">
                        <input className={cell} value={p.note} onChange={(e) => set({ plant: patchRow(report.plant, p.id, { note: e.target.value }) })} aria-label={`Plant ${i + 1} note`} disabled={locked} />
                      </td>
                      <td className="px-2 py-1.5">
                        <button type="button" onClick={() => set({ plant: report.plant.filter((x) => x.id !== p.id) })} className="p-1 text-gray-400 hover:text-red-600" aria-label={`Remove plant ${i + 1}`} disabled={locked}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {report.plant.length === 0 && (
                    <tr><td colSpan={5} className="px-3 py-4 text-center text-gray-400">No machinery recorded.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <datalist id="dsr-plant">{PLANT.map((p) => <option key={p} value={p} />)}</datalist>
          </div>
        )}

        {/* MATERIALS */}
        {section === 'materials' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-500">Material movement at site. Purchases are posted in the Ledger; this is the site record.</p>
              <button type="button" onClick={() => set({ materials: [...report.materials, blankMaterialRow()] })} className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded px-2 py-1" data-testid="dsr-add-material" disabled={locked}>
                <Plus className="w-3.5 h-3.5" /> Add material
              </button>
            </div>
            <div className="overflow-x-auto border border-gray-200 rounded-lg">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-gray-500">
                  <tr>
                    <th className="px-2 py-1.5 text-left">Material</th>
                    <th className="px-2 py-1.5 text-left w-16">Unit</th>
                    <th className="px-2 py-1.5 text-right w-20">Received</th>
                    <th className="px-2 py-1.5 text-right w-20">Used</th>
                    <th className="px-2 py-1.5 text-left w-32">Supplier</th>
                    <th className="px-2 py-1.5 text-left w-28">Challan no.</th>
                    <th className="px-2 py-1.5 w-8"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {report.materials.map((m, i) => (
                    <tr key={m.id}>
                      <td className="px-2 py-1.5">
                        <input className={cell} value={m.name} onChange={(e) => set({ materials: patchRow(report.materials, m.id, { name: e.target.value }) })} aria-label={`Material ${i + 1} name`} disabled={locked} />
                      </td>
                      <td className="px-2 py-1.5">
                        <input className={cell} value={m.unit} onChange={(e) => set({ materials: patchRow(report.materials, m.id, { unit: e.target.value }) })} aria-label={`Material ${i + 1} unit`} disabled={locked} />
                      </td>
                      <td className="px-2 py-1.5">
                        <input type="number" step="any" className={`${cell} text-right`} value={m.received || ''} onChange={(e) => set({ materials: patchRow(report.materials, m.id, { received: Number(e.target.value) || 0 }) })} aria-label={`Material ${i + 1} received`} disabled={locked} />
                      </td>
                      <td className="px-2 py-1.5">
                        <input type="number" step="any" className={`${cell} text-right`} value={m.used || ''} onChange={(e) => set({ materials: patchRow(report.materials, m.id, { used: Number(e.target.value) || 0 }) })} aria-label={`Material ${i + 1} used`} disabled={locked} />
                      </td>
                      <td className="px-2 py-1.5">
                        <input className={cell} value={m.supplier} onChange={(e) => set({ materials: patchRow(report.materials, m.id, { supplier: e.target.value }) })} aria-label={`Material ${i + 1} supplier`} disabled={locked} />
                      </td>
                      <td className="px-2 py-1.5">
                        <input className={cell} value={m.challan} onChange={(e) => set({ materials: patchRow(report.materials, m.id, { challan: e.target.value }) })} aria-label={`Material ${i + 1} challan`} disabled={locked} />
                      </td>
                      <td className="px-2 py-1.5">
                        <button type="button" onClick={() => set({ materials: report.materials.filter((x) => x.id !== m.id) })} className="p-1 text-gray-400 hover:text-red-600" aria-label={`Remove material ${i + 1}`} disabled={locked}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {report.materials.length === 0 && (
                    <tr><td colSpan={7} className="px-3 py-4 text-center text-gray-400">No material received or used today.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TESTS */}
        {section === 'tests' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-500">Quality control: cube, slump, compaction, sieve, CBR.</p>
              <button type="button" onClick={() => set({ tests: [...report.tests, blankTestRow()] })} className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded px-2 py-1" data-testid="dsr-add-test" disabled={locked}>
                <Plus className="w-3.5 h-3.5" /> Add test
              </button>
            </div>
            <div className="overflow-x-auto border border-gray-200 rounded-lg">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-gray-500">
                  <tr>
                    <th className="px-2 py-1.5 text-left">Test</th>
                    <th className="px-2 py-1.5 text-left w-32">At (location)</th>
                    <th className="px-2 py-1.5 text-left w-40">Result</th>
                    <th className="px-2 py-1.5 text-center w-16">Passed</th>
                    <th className="px-2 py-1.5 w-8"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {report.tests.map((t, i) => (
                    <tr key={t.id}>
                      <td className="px-2 py-1.5">
                        <input className={cell} list="dsr-tests" value={t.kind} onChange={(e) => set({ tests: patchRow(report.tests, t.id, { kind: e.target.value }) })} aria-label={`Test ${i + 1} kind`} disabled={locked} />
                      </td>
                      <td className="px-2 py-1.5">
                        <input className={cell} value={t.location} onChange={(e) => set({ tests: patchRow(report.tests, t.id, { location: e.target.value }) })} aria-label={`Test ${i + 1} location`} disabled={locked} />
                      </td>
                      <td className="px-2 py-1.5">
                        <input className={cell} value={t.result} onChange={(e) => set({ tests: patchRow(report.tests, t.id, { result: e.target.value }) })} placeholder="28.5 N/mm² / 40 mm slump" aria-label={`Test ${i + 1} result`} disabled={locked} />
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        <input type="checkbox" checked={t.passed} onChange={(e) => set({ tests: patchRow(report.tests, t.id, { passed: e.target.checked }) })} aria-label={`Test ${i + 1} passed`} disabled={locked} />
                      </td>
                      <td className="px-2 py-1.5">
                        <button type="button" onClick={() => set({ tests: report.tests.filter((x) => x.id !== t.id) })} className="p-1 text-gray-400 hover:text-red-600" aria-label={`Remove test ${i + 1}`} disabled={locked}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {report.tests.length === 0 && (
                    <tr><td colSpan={5} className="px-3 py-4 text-center text-gray-400">No test today.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <datalist id="dsr-tests">{TESTS.map((t) => <option key={t} value={t} />)}</datalist>
          </div>
        )}

        {/* SITE */}
        {section === 'site' && (
          <div className="space-y-4">
            <div className="grid md:grid-cols-2 gap-4">
              <div className="border border-gray-200 rounded-xl p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-600">Lost time ({delayHours(report)} h)</p>
                  <button type="button" onClick={() => set({ delays: [...report.delays, blankDelayRow()] })} className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded px-2 py-1" data-testid="dsr-add-delay" disabled={locked}>
                    <Plus className="w-3.5 h-3.5" /> Add delay
                  </button>
                </div>
                {report.delays.map((d, i) => (
                  <div key={d.id} className="flex gap-2 items-center">
                    <input className={cell} value={d.reason} onChange={(e) => set({ delays: patchRow(report.delays, d.id, { reason: e.target.value }) })} placeholder="Rain / strike / no drawing / breakdown" aria-label={`Delay ${i + 1} reason`} disabled={locked} />
                    <input type="number" step="any" className={`${cell} w-20 text-right`} value={d.hours || ''} onChange={(e) => set({ delays: patchRow(report.delays, d.id, { hours: Number(e.target.value) || 0 }) })} aria-label={`Delay ${i + 1} hours`} disabled={locked} />
                    <button type="button" onClick={() => set({ delays: report.delays.filter((x) => x.id !== d.id) })} className="p-1 text-gray-400 hover:text-red-600" aria-label={`Remove delay ${i + 1}`} disabled={locked}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
                {report.delays.length === 0 && <p className="text-xs text-gray-400">No interruption.</p>}
              </div>

              <div className="border border-gray-200 rounded-xl p-3 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-600">Safety</p>
                <label className="flex items-center gap-2 text-xs text-gray-700">
                  <input type="checkbox" checked={report.safety.toolbox} onChange={(e) => set({ safety: { ...report.safety, toolbox: e.target.checked } })} aria-label="Toolbox talk held" disabled={locked} />
                  Toolbox talk held
                </label>
                <label className="flex items-center gap-2 text-xs text-gray-700">
                  <input type="checkbox" checked={report.safety.ppe} onChange={(e) => set({ safety: { ...report.safety, ppe: e.target.checked } })} aria-label="PPE check done" disabled={locked} />
                  PPE / helmet check done
                </label>
                {siteField('Incident (leave blank if none)', (
                  <input className={cell} value={report.safety.incident} onChange={(e) => set({ safety: { ...report.safety, incident: e.target.value } })} aria-label="Safety incident" disabled={locked} />
                ))}
                {siteField('Safety notes', (
                  <input className={cell} value={report.safety.notes} onChange={(e) => set({ safety: { ...report.safety, notes: e.target.value } })} aria-label="Safety notes" disabled={locked} />
                ))}
              </div>
            </div>

            {siteField('Instructions received (engineer / client)', (
              <textarea rows={2} className={cell} value={report.instructions} onChange={(e) => set({ instructions: e.target.value })} aria-label="Instructions received" disabled={locked} />
            ))}
            <div className="grid md:grid-cols-2 gap-4">
              {siteField('Visitors / inspections', (
                <input className={cell} value={report.visitors} onChange={(e) => set({ visitors: e.target.value })} aria-label="Visitors" disabled={locked} />
              ))}
              {siteField('Remarks', (
                <input className={cell} value={report.note} onChange={(e) => set({ note: e.target.value })} aria-label="Report remarks" disabled={locked} />
              ))}
            </div>
          </div>
        )}

        {/* PHOTOS & FILES */}
        {section === 'files' && (
          <DsrAttachments
            report={report}
            locked={locked}
            onAttach={onAttach}
            onDetach={onDetach}
            onOpenInVault={onOpenInVault}
          />
        )}

        {/* Validation */}
        {errors.length > 0 && (
          <div className="border border-gray-200 border-l-2 border-l-red-600 bg-white rounded-lg px-3 py-2 text-xs text-red-700" role="alert" data-testid="dsr-errors">
            <p className="font-semibold flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> Fix these before saving</p>
            <ul className="list-disc pl-5 mt-1 space-y-0.5">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
          </div>
        )}
        {warnings.length > 0 && (
          <div className="border border-gray-200 border-l-2 border-l-amber-600 bg-white rounded-lg px-3 py-2 text-xs text-amber-800" data-testid="dsr-warnings">
            <p className="font-semibold">Check</p>
            <ul className="list-disc pl-5 mt-1 space-y-0.5">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap justify-end gap-2 pt-2 border-t border-gray-100">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 inline-flex items-center gap-1">
            <X className="w-4 h-4" /> Close
          </button>
          <button
            type="button"
            onClick={() => onSave('draft')}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-lg"
            data-testid="dsr-save-draft"
            disabled={errors.length > 0 || report.status === 'approved' || saving}
          >
            {saving ? 'Saving…' : 'Save draft'}
          </button>
          {report.status === 'draft' && (
            <button
              type="button"
              onClick={() => onSave('submitted')}
              className="px-4 py-2 text-sm font-medium text-white bg-gray-900 hover:bg-gray-800 rounded-lg"
              data-testid="dsr-submit"
              disabled={errors.length > 0 || saving}
            >
              Save &amp; submit
            </button>
          )}
          {report.status === 'submitted' && (
            <button
              type="button"
              onClick={() => onSave('approved')}
              className="px-4 py-2 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg"
              data-testid="dsr-approve"
              disabled={errors.length > 0 || saving}
            >
              Approve
            </button>
          )}
        </div>
        <p className="text-[11px] text-gray-400">
          Progress totals: {report.items.reduce((s, i) => s + (Number(i.quantity) || 0), 0)} across {report.items.length} item(s) · labour {labourCount(report)} men / {labourHours(report)} h · lost {delayHours(report)} h
          {report.status === 'approved' && ' · approved reports are locked'}
        </p>
      </div>
    </Modal>
  );
}

export default DsrEditor;
