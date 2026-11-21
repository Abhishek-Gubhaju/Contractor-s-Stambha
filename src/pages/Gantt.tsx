import React, { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CalendarClock, Download, ListChecks, Maximize2, Printer, Target, X, ZoomIn } from 'lucide-react';
import { adToBS, formatBS } from '../utils/nepaliDate';
import { dsrLines } from '../services/dsrService';
import {
  syncFromDSR,
  loadActivities,
  loadDependencies,
  depPhrase,
  ganttListCsv,
  slipDays,
  todayISO,
  addDaysISO,
  daysBetween,
  type Activity,
  type Dependency,
  type SyncAlert,
} from '../services/dsrSyncService';
import { computeCpm } from '../services/cpm';
import { buildScale, colWFor, monthTicks, dayTicks, type Zoom, type Scale } from '../services/ganttScale';
import { usePrintTarget } from '../hooks/usePrintTarget';
import { printCurrentTarget } from '../services/print/printService';

const LEFT_W = 320; // B2: sticky left pane
const ROW_H = 44;
const MONTH_TIER_H = 28;
const DAY_TIER_H = 24;
const HEADER_H = MONTH_TIER_H + DAY_TIER_H;

/** ISO date → "2082 Bhadra 27" via the single date module (A1). */
function bsOf(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = String(iso).slice(0, 10);
  try {
    return formatBS(adToBS(new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)), 12))));
  } catch {
    return '—';
  }
}

function adPretty(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Offline-safe CSV download (data URI works without network and in tests). */
function downloadCsv(csv: string, filename: string) {
  const a = document.createElement('a');
  a.href = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

const STATUS_STYLE: Record<string, string> = {
  done: 'bg-green-100 text-green-700',
  active: 'bg-blue-100 text-blue-700',
  delayed: 'bg-red-100 text-red-700',
  planned: 'bg-gray-100 text-gray-600',
};
const STATUS_LABEL: Record<string, string> = {
  done: 'Done',
  active: 'Active',
  delayed: 'Delayed',
  planned: 'Planned',
};
const BAR_TRACK: Record<string, string> = {
  done: 'bg-green-200',
  active: 'bg-blue-100',
  delayed: 'bg-[repeating-linear-gradient(45deg,#fecaca_0px,#fecaca_6px,#fee2e2_6px,#fee2e2_12px)]',
  planned: 'bg-gray-200',
};
const BAR_FILL: Record<string, string> = {
  done: 'bg-green-600',
  active: 'bg-blue-600',
  delayed: 'bg-red-500',
  planned: 'bg-gray-500',
};
const DIAMOND: Record<string, string> = {
  done: 'bg-green-600',
  active: 'bg-blue-600',
  delayed: 'bg-red-500',
  planned: 'bg-gray-400',
};

interface Row {
  kind: 'sector' | 'activity';
  activity?: Activity;
  sector?: string;
}

export default function GanttPage(props: any) {
  const { boqData = [], dsrData = [], milestones = [], timezone } = props;
  void timezone;

  const [activities, setActivities] = useState<Activity[]>([]);
  const [deps, setDeps] = useState<Dependency[]>([]);
  const [alerts, setAlerts] = useState<SyncAlert[]>([]);
  const [view, setView] = useState<'gantt' | 'list' | 'milestone'>('gantt');
  const [zoom, setZoom] = useState<Zoom>('week');
  const [showCritical, setShowCritical] = useState(false);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [containerWidth, setContainerWidth] = useState(900);
  const scrollRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<HTMLDivElement>(null);

  // C4: recompute derived columns on DSR-save events (prop change), never at render
  useEffect(() => {
    const res = syncFromDSR({ dsrData, boqData, milestones });
    setActivities(res.activities);
    setAlerts(res.alerts);
    setDeps(loadDependencies());
  }, [dsrData, boqData, milestones]);

  // C1: focus hint written by the DSR page link
  useEffect(() => {
    const focus = localStorage.getItem('contractoros_gantt_focus');
    if (!focus) return;
    localStorage.removeItem('contractoros_gantt_focus');
    const target = loadActivities().find((a) => a.code && a.code.toLowerCase() === focus.toLowerCase());
    if (target) setDrawerId(target.id);
  }, []);

  // container width for Fit zoom: keep it in lockstep with real layout —
  // re-measured after EVERY render (fixes stale widths before paint) and on
  // viewport resize. A lone ResizeObserver proved unreliable here (fit width
  // is a fixed point of the measure→render loop, so a stale value never clears).
  const syncWidth = useCallback(() => {
    const el = chartRef.current;
    if (!el) return;
    const w = Math.max(360, (el.clientWidth || 900) - LEFT_W);
    setContainerWidth((prev) => (prev === w ? prev : w));
  }, []);

  useLayoutEffect(syncWidth);

  useEffect(() => {
    window.addEventListener('resize', syncWidth);
    return () => window.removeEventListener('resize', syncWidth);
  }, [syncWidth]);

  const today = todayISO();
  const cpm = useMemo(() => computeCpm(activities, deps), [activities, deps]);
  const criticalSet = useMemo(() => new Set(cpm.criticalIds), [cpm]);

  // ---- shared range + THE single scale (B1/E1) ----
  const range = useMemo(() => {
    const dates: string[] = [today];
    for (const a of activities) {
      for (const d of [a.start, a.end, a.baseline_start, a.baseline_end, a.actual_start, a.forecast_finish]) {
        if (d) dates.push(String(d).slice(0, 10));
      }
    }
    dates.sort();
    const min = addDaysISO(dates[0], -2);
    const max = addDaysISO(dates[dates.length - 1], 5);
    return { min, max };
  }, [activities, today]);

  const scale: Scale = useMemo(() => {
    const days = Math.max(1, daysBetween(range.min, range.max) + 1);
    return buildScale({ minISO: range.min, maxISO: range.max, colW: colWFor(zoom, containerWidth, days) });
  }, [range, zoom, containerWidth]);

  const months = useMemo(() => monthTicks(scale), [scale]);
  const days = useMemo(() => dayTicks(scale), [scale]);

  // ---- flat row order (left pane + timeline share it; arrows use it for y) ----
  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    const sectors: string[] = [];
    activities.forEach((a) => {
      if (!sectors.includes(a.sector || 'General')) sectors.push(a.sector || 'General');
    });
    for (const sector of sectors) {
      const inSector = activities.filter((a) => (a.sector || 'General') === sector);
      out.push({ kind: 'sector', sector });
      for (const a of inSector) out.push({ kind: 'activity', activity: a });
    }
    return out;
  }, [activities]);

  const rowIndex = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => {
      if (r.kind === 'activity' && r.activity) m.set(r.activity.id, i);
    });
    return m;
  }, [rows]);

  const byId = useMemo(() => new Map(activities.map((a) => [a.id, a] as const)), [activities]);

  // The chart (or list / milestone view) is the sheet Cmd+P and Print print.
  // fitWidth: at day/week zoom the chart is wider than A4 landscape, so the
  // print clone is scaled onto the printable width instead of being clipped.
  const printRef = usePrintTarget<HTMLDivElement>({ title: `Gantt Schedule ${today}`, landscape: true, fitWidth: true });

  const jumpToday = () => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = Math.max(0, scale.x(today) - el.clientWidth / 2 + LEFT_W);
  };

  const openDrawer = (id: string) => setDrawerId(id);
  const drawerAct = drawerId ? byId.get(drawerId) || null : null;

  const exportCsv = () => {
    downloadCsv(ganttListCsv(activities), `gantt_schedule_${today}.csv`);
  };

  const zooms: Array<{ key: Zoom; label: string; icon: React.ReactNode }> = [
    { key: 'day', label: 'Day', icon: <ZoomIn className="w-3.5 h-3.5" /> },
    { key: 'week', label: 'Week', icon: <ListChecks className="w-3.5 h-3.5" /> },
    { key: 'month', label: 'Month', icon: <CalendarClock className="w-3.5 h-3.5" /> },
    { key: 'fit', label: 'Fit', icon: <Maximize2 className="w-3.5 h-3.5" /> },
  ];

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      {(['gantt', 'list', 'milestone'] as const).map((v) => (
        <button
          key={v}
          onClick={() => setView(v)}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium border ${view === v ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}
        >
          {v === 'gantt' ? 'Gantt' : v === 'list' ? 'List' : 'Milestones'}
        </button>
      ))}
      <span className="w-px h-6 bg-gray-200 mx-1" />
      {zooms.map((z) => (
        <button
          key={z.key}
          onClick={() => setZoom(z.key)}
          aria-label={`Zoom ${z.label}`}
          title={`${z.label} zoom`}
          className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border ${zoom === z.key ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}
        >
          {z.icon}
          {z.label}
        </button>
      ))}
      <button onClick={jumpToday} className="px-2.5 py-1.5 rounded-lg text-xs font-medium border border-gray-200 text-gray-600 hover:bg-gray-50">
        Today
      </button>
      <button
        onClick={() => setShowCritical((v) => !v)}
        data-testid="critical-toggle"
        className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border ${showCritical ? 'bg-red-600 text-white border-red-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}
      >
        Critical path
      </button>
      <span className="w-px h-6 bg-gray-200 mx-1" />
      <button onClick={exportCsv} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-gray-200 text-gray-600 hover:bg-gray-50">
        <Download className="w-3.5 h-3.5" /> CSV
      </button>
      <button onClick={() => void printCurrentTarget()} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-gray-200 text-gray-600 hover:bg-gray-50">
        <Printer className="w-3.5 h-3.5" /> Print / PDF
      </button>
    </div>
  );

  const alertStrip = alerts.length > 0 && (
    <div data-testid="gantt-alerts" className="bg-white border rounded-xl divide-y">
      {alerts.map((a) => (
        <div key={a.id} className={`flex items-start gap-2 px-4 py-2 text-xs ${a.severity === 'red' ? 'text-red-700 bg-red-50' : 'text-amber-800 bg-amber-50'}`}>
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{a.message}</span>
        </div>
      ))}
    </div>
  );

  return (
    <div className="space-y-4" data-testid="gantt-page">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1>Gantt Chart</h1>
          <p className="text-sm text-gray-500">
            Schedule synced from DSR — today: {adPretty(today)} ({bsOf(today)})
          </p>
        </div>
        {toolbar}
      </div>

      {alertStrip}

      <div ref={printRef}>
      {view === 'gantt' && (
        <div ref={chartRef} className="bg-white border rounded-xl overflow-hidden">
          <div ref={scrollRef} className="relative overflow-auto max-h-[72vh]" data-testid="gantt-scroll">
            <div className="relative" style={{ width: LEFT_W + scale.width }}>
              {/* two-tier header (sticky) */}
              <div className="sticky top-0 z-30 flex border-b bg-gray-50" style={{ height: HEADER_H }}>
                <div className="sticky left-0 z-40 bg-gray-50 border-r shrink-0 flex items-end px-3 pb-1" style={{ width: LEFT_W }}>
                  <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Activity · duration · progress</span>
                </div>
                <div className="relative" style={{ width: scale.width }}>
                  <div className="relative border-b" style={{ height: MONTH_TIER_H }}>
                    {months.map((m, i) => (
                      <div key={i} className="absolute top-0 h-full border-l border-gray-300 pl-1 flex items-center text-[11px] font-semibold text-gray-600 overflow-hidden" style={{ left: m.left, width: m.width }}>
                        {m.width > 40 && m.label}
                      </div>
                    ))}
                  </div>
                  <div className="relative" style={{ height: DAY_TIER_H }}>
                    {/* sub-3px columns would draw borders every pixel — month tier + month gridlines carry the structure instead */}
                    {scale.colW < 3 ? null : days.map((d) => (
                      <div
                        key={d.iso}
                        data-day-tick={d.iso}
                        className={`absolute top-0 h-full border-l ${d.monthStart ? 'border-gray-400' : 'border-gray-200'} ${d.weekend ? 'bg-slate-200/70' : ''} flex items-center justify-center text-[9px] text-gray-500`}
                        style={{ left: d.left, width: scale.colW }}
                      >
                        {scale.colW >= 16 ? d.label : d.monthStart || d.label % 5 === 0 ? d.label : ''}
                      </div>
                    ))}
                  </div>
                  {/* today segment in header */}
                  <div
                    data-testid="today-line-header"
                    className="absolute top-0 bottom-0 border-l-2 border-dashed border-red-500 z-10"
                    style={{ left: scale.x(today) }}
                  >
                    <span className="absolute -top-0 left-1 bg-red-50 text-red-700 text-[9px] px-1 rounded whitespace-nowrap">Today</span>
                  </div>
                </div>
              </div>

              {/* rows */}
              <div className="relative" data-testid="gantt-rows" style={{ height: rows.length * ROW_H }}>
                {/* weekend + month gridlines behind everything (timeline half) */}
                <div className="absolute top-0 bottom-0" style={{ left: LEFT_W, width: scale.width }}>
                  {days.map((d) =>
                    d.weekend ? (
                      <div key={d.iso} className={`absolute top-0 bottom-0 bg-slate-100/70 ${scale.colW < 5 ? 'hidden' : ''}`} style={{ left: d.left, width: scale.colW }} />
                    ) : null
                  )}
                  {months.map((m, i) => (
                    <div key={i} className="absolute top-0 bottom-0 border-l border-gray-300" style={{ left: m.left }} />
                  ))}
                </div>

                {rows.map((row, i) => {
                  const yTop = i * ROW_H;
                  if (row.kind === 'sector') {
                    const children = activities.filter((a) => (a.sector || 'General') === row.sector);
                    const starts = children.map((a) => a.start || '').filter(Boolean).sort();
                    const ends = children.map((a) => a.end || '').filter(Boolean).sort();
                    const sL = starts.length ? scale.x(starts[0]) : 0;
                    const eR = ends.length ? scale.x(ends[ends.length - 1]) + scale.colW : 0;
                    const w = Math.max(0, eR - sL);
                    return (
                      <div key={`sector-${row.sector}-${i}`} className="flex border-b bg-slate-50/80" style={{ height: ROW_H }} data-sector-row={row.sector}>
                        <div className="sticky left-0 z-20 bg-slate-100 border-r shrink-0 flex items-center gap-2 px-3" style={{ width: LEFT_W }}>
                          <span className="text-xs font-bold text-gray-700 truncate">{row.sector}</span>
                          <span className="text-[10px] text-gray-400">{children.length}</span>
                        </div>
                        <div className="relative" style={{ width: scale.width }}>
                          {/* bracket summary bar (B3) */}
                          <div className="absolute" style={{ left: sL, width: w, top: 8 }}>
                            <div className="h-[3px] bg-gray-600 rounded-full" />
                            <div className="flex justify-between">
                              <div className="w-[3px] h-2 bg-gray-600" />
                              <div className="w-[3px] h-2 bg-gray-600" />
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  }

                  const act = row.activity!;
                  const x1 = scale.x(act.start);
                  const x2 = scale.x(act.end) + scale.colW;
                  const w = Math.max(6, x2 - x1);
                  const isMs = act.is_milestone;
                  const critical = showCritical && criticalSet.has(act.id);
                  const slip = slipDays(act);

                  return (
                    <div
                      key={act.id}
                      className="flex border-b hover:bg-slate-50/60"
                      style={{ height: ROW_H }}
                      data-act-row={act.id}
                      data-status={act.status_cache}
                      data-progress={act.progress}
                    >
                      {/* sticky left pane */}
                      <div
                        className="sticky left-0 z-20 bg-white border-r shrink-0 flex items-center gap-2 px-3 cursor-pointer"
                        style={{ width: LEFT_W }}
                        onClick={() => openDrawer(act.id)}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] font-mono text-gray-400">{act.code || (isMs ? 'MS' : '')}</span>
                            <span className="text-xs font-medium text-gray-800 truncate" title={act.name}>
                              {act.name}
                            </span>
                          </div>
                          <div className="flex items-center gap-1 mt-0.5">
                            <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${STATUS_STYLE[act.status_cache]}`} data-status-chip={act.id}>
                              {STATUS_LABEL[act.status_cache]}
                            </span>
                            <span className="text-[9px] text-gray-400">
                              {act.start && act.end ? `${daysBetween(act.start, act.end) + 1}d` : '—'}
                            </span>
                            {slip !== null && slip !== 0 && (
                              <span className={`text-[9px] px-1 py-0.5 rounded font-semibold ${slip > 0 ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'}`} data-slip-chip={act.id}>
                                {slip > 0 ? `+${slip}Nd vs baseline` : `${slip}Nd vs baseline`}
                              </span>
                            )}
                          </div>
                        </div>
                        <span className="text-[11px] font-mono font-semibold text-gray-600 shrink-0" data-progress-pct={act.id}>
                          {Math.min(100, Math.round(act.progress))}%
                        </span>
                      </div>

                      {/* timeline cell */}
                      <div className="relative" style={{ width: scale.width }} onClick={() => openDrawer(act.id)}>
                        {/* baseline ghost (B4) */}
                        {act.baseline_start && act.baseline_end && (
                          <div
                            className="absolute border border-dashed border-gray-400 rounded-sm"
                            style={{ left: scale.x(act.baseline_start), width: Math.max(4, scale.x(act.baseline_end) + scale.colW - scale.x(act.baseline_start)), top: ROW_H - 9, height: 5 }}
                            title={`Baseline: ${act.baseline_start} → ${act.baseline_end}`}
                          />
                        )}
                        {isMs ? (
                          <div
                            data-act-bar={act.id}
                            className={`absolute w-3.5 h-3.5 rotate-45 border border-white shadow ${DIAMOND[act.status_cache]} ${critical ? 'ring-2 ring-red-600' : ''}`}
                            style={{ left: scale.xCenter(act.end) - 7, top: ROW_H / 2 - 7 }}
                            onMouseEnter={() => setHover({ id: act.id, x: LEFT_W + scale.xCenter(act.end), y: i * ROW_H })}
                            onMouseLeave={() => setHover(null)}
                            onClick={(e) => {
                              e.stopPropagation();
                              openDrawer(act.id);
                            }}
                          />
                        ) : (
                          <div
                            data-act-bar={act.id}
                            className={`absolute rounded-md overflow-hidden ${BAR_TRACK[act.status_cache]} ${critical ? 'ring-2 ring-red-600' : ''}`}
                            style={{ left: x1, width: w, top: 10, height: 16 }}
                            onMouseEnter={() => setHover({ id: act.id, x: LEFT_W + x1, y: i * ROW_H })}
                            onMouseLeave={() => setHover(null)}
                          >
                            <div
                              className={`h-full ${BAR_FILL[act.status_cache]}`}
                              style={{ width: `${Math.max(0, Math.min(100, act.progress))}%` }}
                              data-progress-fill={act.id}
                            />
                            {w > 70 && (
                              <span className="absolute inset-y-0 left-1.5 flex items-center text-[9px] font-semibold text-white drop-shadow-sm truncate" style={{ maxWidth: w - 10 }}>
                                {act.name}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}

                {/* dependency arrows (B5/B6) — one path per dependency */}
                <svg
                  className="absolute top-0 pointer-events-none"
                  style={{ left: LEFT_W, width: scale.width, height: rows.length * ROW_H }}
                  data-testid="dep-arrows"
                >
                  <defs>
                    <marker id="dep-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                      <path d="M0,0 L8,4 L0,8 z" fill="#94a3b8" />
                    </marker>
                    <marker id="dep-arrow-red" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                      <path d="M0,0 L8,4 L0,8 z" fill="#dc2626" />
                    </marker>
                  </defs>
                  {deps.map((dep) => {
                    const fi = rowIndex.get(dep.from_id);
                    const ti = rowIndex.get(dep.to_id);
                    const from = byId.get(dep.from_id);
                    const to = byId.get(dep.to_id);
                    if (fi === undefined || ti === undefined || !from || !to) return null;
                    const y1 = fi * ROW_H + ROW_H / 2;
                    const y2 = ti * ROW_H + ROW_H / 2;
                    const fromEnd = dep.type === 'FS' || dep.type === 'FF';
                    const toEnd = dep.type === 'FF' || dep.type === 'SF';
                    const x1 = fromEnd ? scale.x(from.end) + scale.colW : scale.x(from.start);
                    const x2 = (toEnd ? scale.x(to.end) + scale.colW : scale.x(to.start)) + dep.lag_days * scale.colW;
                    const critical = showCritical && criticalSet.has(dep.from_id) && criticalSet.has(dep.to_id);
                    const path = `M ${x1} ${y1} C ${x1 + Math.max(12, scale.colW * 2)} ${y1}, ${x2 - Math.max(12, scale.colW * 2)} ${y2}, ${x2} ${y2}`;
                    return (
                      <path
                        key={dep.id}
                        d={path}
                        fill="none"
                        data-dep-arrow={dep.id}
                        stroke={critical ? '#dc2626' : '#94a3b8'}
                        strokeWidth={critical ? 2 : 1.25}
                        markerEnd={critical ? 'url(#dep-arrow-red)' : 'url(#dep-arrow)'}
                      />
                    );
                  })}
                </svg>

                {/* today line across rows */}
                <div
                  data-testid="today-line"
                  className="absolute top-0 bottom-0 border-l-2 border-dashed border-red-500 z-10 pointer-events-none"
                  style={{ left: LEFT_W + scale.x(today) }}
                />
              </div>

              {/* tooltip (B7) */}
              {hover && byId.get(hover.id) && (
                <Tooltip
                  act={byId.get(hover.id)!}
                  deps={deps}
                  activities={activities}
                  today={today}
                  style={{ left: Math.max(LEFT_W, Math.min(hover.x + 8, LEFT_W + scale.width - 260)), top: Math.max(HEADER_H + 4, hover.y - 4) }}
                />
              )}
            </div>
          </div>
          <Legend />
        </div>
      )}

      {view === 'list' && <ListView activities={activities} today={today} />}

      {view === 'milestone' && <MilestoneView activities={activities} today={today} />}
      </div>

      {drawerAct && (
        <ActivityDrawer act={drawerAct} deps={deps} activities={activities} dsrData={dsrData} boqData={boqData} today={today} onClose={() => setDrawerId(null)} />
      )}

    </div>
  );
}

// ---------------------------------------------------------------------------
// Tooltip (B7) — both calendars, plain-language predecessors (B5)
// ---------------------------------------------------------------------------
function Tooltip({ act, deps, activities, today, style }: { act: Activity; deps: Dependency[]; activities: Activity[]; today: string; style: React.CSSProperties }) {
  const preds = deps.filter((d) => d.to_id === act.id);
  const slip = slipDays(act);
  const dur = act.start && act.end ? daysBetween(act.start, act.end) + 1 : 0;
  const line = (label: string, ad: string | null) => (
    <div className="flex justify-between gap-4">
      <span className="text-gray-400">{label}</span>
      <span className="text-right">
        {ad ? (
          <>
            {adPretty(ad)}
            <span className="block text-[10px] text-indigo-300">{bsOf(ad)}</span>
          </>
        ) : (
          '—'
        )}
      </span>
    </div>
  );
  return (
    <div
      data-testid="gantt-tooltip"
      className="absolute z-40 w-64 bg-slate-900 text-white text-[11px] rounded-lg shadow-xl p-3 space-y-1 pointer-events-none"
      style={style}
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] text-slate-400">{act.code}</span>
        <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-medium ${STATUS_STYLE[act.status_cache]}`}>{STATUS_LABEL[act.status_cache]}</span>
      </div>
      <p className="font-semibold text-xs">{act.name}</p>
      <div className="text-[11px] space-y-0.5">
        {line('Planned start', act.start)}
        {line('Planned end', act.end)}
        {line('Actual start', act.actual_start)}
        {line('Actual finish', act.actual_finish)}
        {line('Forecast finish', act.forecast_finish)}
      </div>
      <div className="flex justify-between">
        <span className="text-slate-400">Duration</span>
        <span>{dur} days</span>
      </div>
      <div className="flex justify-between">
        <span className="text-slate-400">Progress</span>
        <span>{Math.min(100, Math.round(act.progress))}%</span>
      </div>
      {slip !== null && (
        <div className="flex justify-between">
          <span className="text-slate-400">Slip vs baseline</span>
          <span className={slip > 0 ? 'text-red-400' : 'text-blue-300'}>{slip > 0 ? `+${slip}d` : `${slip}d`}</span>
        </div>
      )}
      {preds.length > 0 && (
        <div className="pt-1 border-t border-slate-700 space-y-0.5">
          {preds.map((d) => (
            <p key={d.id} className="text-[10px] text-slate-300">
              {depPhrase(d, activities)}
            </p>
          ))}
        </div>
      )}
      <p className="text-[10px] text-slate-500 pt-1">Today: {adPretty(today)} · {bsOf(today)}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legend (B8 — kept in DOM for print)
// ---------------------------------------------------------------------------
function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-4 px-4 py-2 border-t bg-gray-50 text-[11px] text-gray-600" data-testid="gantt-legend">
      <span className="flex items-center gap-1"><span className="w-4 h-2.5 rounded bg-green-600" /> Done</span>
      <span className="flex items-center gap-1"><span className="w-4 h-2.5 rounded bg-blue-600" /> Active</span>
      <span className="flex items-center gap-1"><span className="w-4 h-2.5 rounded bg-[repeating-linear-gradient(45deg,#fecaca_0px,#fecaca_3px,#fee2e2_3px,#fee2e2_6px)] border border-red-400" /> Delayed</span>
      <span className="flex items-center gap-1"><span className="w-4 h-2.5 rounded bg-gray-500" /> Planned</span>
      <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rotate-45 bg-gray-400" /> Milestone</span>
      <span className="flex items-center gap-1"><span className="w-4 border-t border-dashed border-gray-500" /> Baseline</span>
      <span className="flex items-center gap-1"><span className="w-4 border-l-2 border-dashed border-red-500 h-3" /> Today</span>
      <span className="flex items-center gap-1"><span className="w-4 h-2.5 border-2 border-red-600 rounded" /> Critical</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// List view (B8 + F9 CSV)
// ---------------------------------------------------------------------------
function ListView({ activities, today }: { activities: Activity[]; today: string }) {
  const exportCsv = () => {
    downloadCsv(ganttListCsv(activities), `gantt_list_${today}.csv`);
  };
  return (
    <div className="bg-white border rounded-xl overflow-x-auto" data-testid="gantt-list">
      <div className="flex justify-end px-4 pt-3">
        <button onClick={exportCsv} className="flex items-center gap-1 text-xs font-medium border border-gray-200 rounded-lg px-3 py-1.5 text-gray-600 hover:bg-gray-50">
          <Download className="w-3.5 h-3.5" /> Export CSV
        </button>
      </div>
      <table className="w-full text-sm mt-2">
        <thead className="bg-gray-50 border-b">
          <tr className="text-left text-xs text-gray-500">
            <th className="px-4 py-2">Code</th>
            <th className="px-4 py-2">Activity</th>
            <th className="px-4 py-2">Status</th>
            <th className="px-4 py-2">Start (AD)</th>
            <th className="px-4 py-2">End (AD)</th>
            <th className="px-4 py-2">End (B.S.)</th>
            <th className="px-4 py-2 text-right">Progress</th>
            <th className="px-4 py-2 text-right">Slip</th>
            <th className="px-4 py-2">Forecast</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {activities.map((a) => {
            const slip = slipDays(a);
            return (
              <tr key={a.id} className="hover:bg-gray-50" data-list-row={a.id}>
                <td className="px-4 py-2 font-mono text-xs text-gray-500">{a.code}</td>
                <td className="px-4 py-2">
                  {a.name}
                  {a.is_milestone && <span className="ml-1.5 text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">milestone</span>}
                </td>
                <td className="px-4 py-2">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${STATUS_STYLE[a.status_cache]}`}>{STATUS_LABEL[a.status_cache]}</span>
                </td>
                <td className="px-4 py-2 text-xs">{a.start || '—'}</td>
                <td className="px-4 py-2 text-xs">{a.end || '—'}</td>
                <td className="px-4 py-2 text-xs text-indigo-600">{bsOf(a.end)}</td>
                <td className="px-4 py-2 text-right font-mono text-xs">{Math.min(100, Math.round(a.progress))}%</td>
                <td className={`px-4 py-2 text-right text-xs font-semibold ${slip && slip > 0 ? 'text-red-600' : 'text-gray-500'}`} data-list-slip={a.id}>
                  {slip === null ? '—' : slip > 0 ? `+${slip}d` : `${slip}d`}
                </td>
                <td className="px-4 py-2 text-xs">{a.forecast_finish || '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Milestones view (B8 + F4)
// ---------------------------------------------------------------------------
function MilestoneView({ activities, today }: { activities: Activity[]; today: string }) {
  const ms = activities.filter((a) => a.is_milestone);
  if (!ms.length) return <div className="bg-white border rounded-xl p-8 text-center text-gray-400">No milestones yet.</div>;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4" data-testid="milestone-view">
      {ms.map((m) => {
        const remaining = m.end ? daysBetween(today, m.end) : 0;
        const done = m.status_cache === 'done';
        return (
          <div key={m.id} className="bg-white border rounded-xl p-4" data-milestone-card={m.id}>
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className={`w-3 h-3 rotate-45 ${DIAMOND[m.status_cache]}`} />
                <h4 className="font-semibold text-sm">{m.name}</h4>
              </div>
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${STATUS_STYLE[m.status_cache]}`}>{STATUS_LABEL[m.status_cache]}</span>
            </div>
            <p className="text-xs text-gray-500 mt-1 font-mono">{m.code}</p>
            <div className="mt-3 space-y-1 text-xs">
              <div className="flex justify-between">
                <span className="text-gray-400">Target (AD)</span>
                <span>{m.end || '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Target (B.S.)</span>
                <span className="text-indigo-600">{bsOf(m.end)}</span>
              </div>
              {done ? (
                <>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Actual date</span>
                    <span className="text-green-700 font-medium" data-milestone-actual={m.id}>{m.actual_finish || '—'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Remaining</span>
                    <span className="text-green-700 font-semibold" data-milestone-remaining={m.id}>0 days</span>
                  </div>
                </>
              ) : (
                <div className="flex justify-between">
                  <span className="text-gray-400">Remaining</span>
                  <span className={remaining < 0 ? 'text-red-600 font-semibold' : 'text-gray-700 font-medium'} data-milestone-remaining={m.id}>
                    {remaining < 0 ? `overdue ${Math.abs(remaining)}d` : `${remaining}d remaining`}
                  </span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-gray-400">Progress</span>
                <span>{Math.min(100, Math.round(m.progress))}%</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row drawer (B7) — read-only DSR history, both calendars, newest first
// ---------------------------------------------------------------------------
function ActivityDrawer({ act, deps, activities, dsrData, boqData, today, onClose }: {
  act: Activity;
  deps: Dependency[];
  activities: Activity[];
  dsrData: any[];
  boqData: any[];
  today: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const preds = deps.filter((d) => d.to_id === act.id);
  const history = dsrLines(dsrData as any[])
    .filter((l) => String(l.boqCode || '').trim().toLowerCase() === String(act.code || '').trim().toLowerCase())
    .map((l) => ({
      id: `${l.reportId}:${l.date}:${l.boqCode}`,
      date: l.date,
      workSummary: l.description || l.location,
      workQuantity: l.quantity,
      unit: l.unit,
    }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date))); // newest first
  const boqItem = (boqData || [])
    .flatMap((s: any) => s.children || [])
    .find((c: any) => String(c.itemCode).toLowerCase() === String(act.code).toLowerCase());
  const slip = slipDays(act);

  return (
    <aside
      data-testid="gantt-drawer"
      className="fixed right-0 top-16 bottom-0 w-full sm:w-96 bg-white border-l shadow-2xl z-40 overflow-y-auto"
      aria-label={`Activity details: ${act.name}`}
    >
      <div className="sticky top-0 bg-white border-b px-4 py-3 flex items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-mono text-gray-400">{act.code} · {act.sector}</p>
          <h3 className="font-semibold text-sm">{act.name}</h3>
          <span className={`inline-block mt-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${STATUS_STYLE[act.status_cache]}`} data-testid="drawer-status">
            {STATUS_LABEL[act.status_cache]}
          </span>
        </div>
        <button onClick={onClose} aria-label="Close drawer" className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-4 space-y-4 text-xs">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Planned start (AD)" value={act.start || '—'} />
          <Field label="Planned end (AD)" value={act.end || '—'} />
          <Field label="Planned start (B.S.)" value={bsOf(act.start)} accent />
          <Field label="Planned end (B.S.)" value={bsOf(act.end)} accent />
          <Field label="Actual start" value={act.actual_start ? `${act.actual_start} · ${bsOf(act.actual_start)}` : '—'} />
          <Field label="Actual finish" value={act.actual_finish ? `${act.actual_finish} · ${bsOf(act.actual_finish)}` : '—'} />
          <Field label="Forecast finish" value={act.forecast_finish ? `${act.forecast_finish} · ${bsOf(act.forecast_finish)}` : '—'} />
          <Field label="Baseline" value={act.baseline_start && act.baseline_end ? `${act.baseline_start} → ${act.baseline_end}` : '—'} />
        </div>

        <div>
          <div className="flex justify-between mb-1">
            <span className="text-gray-500">Progress</span>
            <span className="font-semibold" data-testid="drawer-progress">{Math.min(100, Math.round(act.progress))}%</span>
          </div>
          <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
            <div className={`h-full ${BAR_FILL[act.status_cache]}`} style={{ width: `${Math.max(0, Math.min(100, act.progress))}%` }} />
          </div>
          {slip !== null && (
            <p className={`mt-1 text-[11px] ${slip > 0 ? 'text-red-600' : 'text-gray-500'}`}>
              {slip > 0 ? `+${slip}d vs baseline` : slip === 0 ? 'On baseline' : `${slip}d vs baseline`}
            </p>
          )}
        </div>

        {preds.length > 0 && (
          <div>
            <p className="text-gray-500 mb-1">Depends on</p>
            {preds.map((d) => (
              <p key={d.id} className="text-gray-700">• {depPhrase(d, activities)}</p>
            ))}
          </div>
        )}

        {boqItem && (
          <div className="bg-blue-50 border border-blue-100 rounded-lg p-3">
            <p className="text-blue-800 font-semibold mb-1">Linked BOQ item</p>
            <p className="text-blue-900">{boqItem.description}</p>
            <p className="text-blue-700 mt-1">
              {boqItem.unit} · qty {Number(boqItem.estimatedQuantity).toLocaleString()} · rate {Number(boqItem.rate).toLocaleString()}
            </p>
          </div>
        )}

        <div>
          <p className="text-gray-500 mb-1.5">DSR history (read-only)</p>
          {history.length === 0 ? (
            <p className="text-gray-400">No DSR entries yet for {act.code || act.name}.</p>
          ) : (
            <div className="space-y-2" data-testid="drawer-dsr-history">
              {history.map((h) => (
                <div key={String(h.id)} className="border rounded-lg p-2 bg-gray-50">
                  <div className="flex justify-between items-center">
                    <span className="font-medium text-gray-800">{adPretty(String(h.date))}</span>
                    <span className="text-indigo-600">{bsOf(String(h.date))}</span>
                  </div>
                  <div className="flex justify-between mt-0.5 text-gray-600">
                    <span>{String(h.workSummary || '')}</span>
                    <span className="font-semibold">{Number(h.workQuantity)} {String(h.unit || '')}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <p className="text-[10px] text-gray-400 border-t pt-2">
          Read-only view — schedule data is derived from DSR reports. Today: {adPretty(today)} ({bsOf(today)}).
        </p>
      </div>
    </aside>
  );
}

function Field({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-gray-50 rounded-lg p-2">
      <p className="text-[10px] text-gray-400">{label}</p>
      <p className={`font-medium ${accent ? 'text-indigo-700' : 'text-gray-800'}`}>{value}</p>
    </div>
  );
}
