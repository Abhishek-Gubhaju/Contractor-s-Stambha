import React, { useMemo, useState } from 'react';
import { Plus, Trash2, Save, X, CheckCircle, CheckCircle2, XCircle, Coffee, DollarSign, List, Table2, ChevronLeft, ChevronRight, Printer, Download, AlertTriangle, Users } from 'lucide-react';
import * as XLSX from 'xlsx';
import { formatCurrency, getCurrentDateInTimezone, getCurrentMonthInTimezone, STANDARD_WORK_HOURS } from '../utils';
import { getTodayBS, formatBS } from '../utils/nepaliDate';
import { useLocalStorage } from '../hooks';
import { getActiveProject, useScopedLocalStorage } from '../services/projectScope';
import { projectNameOf } from '../services/masterData';
import { destroyDialog, notify } from '../components/ui/DialogHost';
import { Modal } from '../components/ui';
import { usePrintTarget } from '../hooks/usePrintTarget';
import { printSheet } from '../services/print/printService';
import { StaffAttendanceSheet, WorkerAttendanceSheet } from './attendance/AttendanceSheets';
import { staffWorkerName } from '../services/labourService';
import {
  STAFF_LEAVE_LIMIT,
  monthPrefixOf,
  staffMonthlySalary,
  staffRowsOn,
  staffStatusIn,
  staffSummaryForMonth,
} from '../services/staffAttendanceService';

export default function AttendancePage(props: any) {
  const { laborData, setLaborData, timezone } = props;
  // Staff are optional: an old caller (or a job with no staff) just gets no section.
  const staffList: any[] = Array.isArray(props.staffData) ? props.staffData : [];
  const [viewMode, setViewMode] = useState<'daily' | 'record'>('daily');
  const [showAddLabor, setShowAddLabor] = useState(false);
  const [newLabor, setNewLabor] = useState({ code: '', name: '', trade: '', dailyWage: '' });
  const [selectedMonth, setSelectedMonth] = useState(getCurrentMonthInTimezone(timezone));
  const [nonWorkingDays, setNonWorkingDays] = useState<Set<number>>(new Set());
  // Attendance is the ONLY source of labour earnings (labourService.computeEarnings),
  // so a saved day must persist in the shared store — not in component state.
  // Shape matches labourService.loadAttendance: { [date]: { project_id, rows[] } }.
  const [attendanceStore, setAttendanceStore] = useScopedLocalStorage<Record<string, any>>('contractoros_attendance', {});
  const savedAttendance = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const [date, value] of Object.entries(attendanceStore || {})) {
      const rows = Array.isArray(value) ? value : value && Array.isArray(value.rows) ? value.rows : [];
      map.set(date, rows);
    }
    return map;
  }, [attendanceStore]);
  const [selectedDate, setSelectedDate] = useState(getCurrentDateInTimezone(timezone));
  // Staff attendance lives in its OWN store: worker attendance drives labour
  // earnings, staff pay is a fixed monthly salary and must never mix in.
  const [staffDate, setStaffDate] = useState(getCurrentDateInTimezone(timezone));
  const [staffStore, setStaffStore] = useScopedLocalStorage<Record<string, any>>('contractoros_staff_attendance', {});
  const staffRowsToday = staffRowsOn(staffStore, staffDate);
  const staffPresentCount = staffRowsToday.filter((r) => r.status === 'present').length;
  const staffAbsentCount = staffRowsToday.filter((r) => r.status === 'absent').length;
  const staffLeaveCount = staffRowsToday.filter((r) => r.status === 'leave').length;
  const staffMonthSummary = staffSummaryForMonth(monthPrefixOf(staffDate), staffList, staffStore);
  const staffOverLimit = staffMonthSummary.filter((s) => s.overLeaveLimit);
  const staffUnmarkedCount = staffList.filter((s) => !staffStatusIn(staffStore, staffDate, String(s.id))).length;

  const toggleStaffStatus = (staffId: string) => {
    const current = staffStatusIn(staffStore, staffDate, staffId);
    const next = current === 'present' ? 'absent' : current === 'absent' ? 'leave' : 'present';
    setStaffStore((prev: any) => {
      const rows = staffRowsOn(prev, staffDate).filter((r) => r.staff_id !== staffId);
      rows.push({ staff_id: staffId, status: next as any });
      return { ...(prev || {}), [staffDate]: { rows } };
    });
  };

  const markAllStaffPresent = () => {
    setStaffStore((prev: any) => ({
      ...(prev || {}),
      [staffDate]: { rows: staffList.map((s: any) => ({ staff_id: String(s.id), status: 'present' })) },
    }));
  };
  const [showSaveConfirm, setShowSaveConfirm] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deletedWorkers, setDeletedWorkers] = useScopedLocalStorage<any[]>('contractoros_labor_deleted', []);
  const [showDeletedPanel, setShowDeletedPanel] = useState(false);
  // Print preview: the sheet is rendered on screen first, then that same DOM
  // goes to paper — no popup window and nothing re-typed for the printer.
  const [printKind, setPrintKind] = useState<'staff' | 'workers' | null>(null);
  const printRef = usePrintTarget<HTMLDivElement>({
    title: `${printKind === 'staff' ? 'Staff' : 'Worker'} Attendance ${selectedMonth}`,
    landscape: true,
  });

  const toggleStatus = (id: string) => {
    setLaborData(laborData.map((l: any) => {
      if (l.id !== id) return l;
      const nextStatus = l.status === 'present' ? 'absent' : l.status === 'absent' ? 'leave' : 'present';
      return { ...l, status: nextStatus, hoursWorked: nextStatus === 'present' ? STANDARD_WORK_HOURS : 0, overtimeHours: 0 };
    }));
  };

  const updateWorkerField = (id: string, field: string, value: number) => {
    setLaborData(laborData.map((l: any) => { if (l.id !== id) return l; return { ...l, [field]: value }; }));
  };

  const saveAttendance = () => {
    const rows = laborData.map((l: any) => ({
      worker_id: l.id,
      workerId: l.id,
      status: l.status,
      hoursWorked: l.hoursWorked,
      overtimeHours: l.overtimeHours,
      ot_hours: l.overtimeHours,
      project_id: l.project_id || '',
    }));
    setAttendanceStore((prev) => {
      const existing = prev?.[selectedDate];
      const project = existing && !Array.isArray(existing) ? existing.project_id || '' : '';
      return { ...(prev || {}), [selectedDate]: { project_id: project, rows } };
    });
    setShowSaveConfirm(true);
    setTimeout(() => setShowSaveConfirm(false), 5000);
  };

  const addLaborer = () => {
    if (!newLabor.name || !newLabor.trade) return;
    let code = newLabor.code;
    if (!code) { let counter = laborData.length + 1; do { code = `WKR-${String(counter).padStart(3, '0')}`; counter++; } while (laborData.some((l: any) => l.code === code)); }
    else if (laborData.some((l: any) => l.code === code)) { notify(`Worker code "${code}" already exists.`, 'error'); return; }
    const laborer: any = { id: `lab-${Date.now()}`, code, name: newLabor.name, trade: newLabor.trade, dailyWage: parseFloat(newLabor.dailyWage) || 0, status: 'present', hoursWorked: STANDARD_WORK_HOURS, overtimeHours: 0, assignedBOQItem: '' };
    setLaborData([...laborData, laborer]);
    setShowAddLabor(false);
    setNewLabor({ code: '', name: '', trade: '', dailyWage: '' });
  };

  const presentCount = laborData.filter((l: any) => l.status === 'present').length;
  const absentCount = laborData.filter((l: any) => l.status === 'absent').length;
  const leaveCount = laborData.filter((l: any) => l.status === 'leave').length;
  const totalDailyCost = laborData.filter((l: any) => l.status === 'present').reduce((sum: number, l: any) => sum + (l.hoursWorked / STANDARD_WORK_HOURS) * l.dailyWage + l.overtimeHours * (l.dailyWage / STANDARD_WORK_HOURS) * 1.5, 0);

  const handleDeleteWorker = async (id: string) => {
    const workerToDelete = laborData.find((l: any) => l.id === id);
    if (!workerToDelete) return;
    const ok = await destroyDialog({
      title: 'Remove worker',
      message: `Remove ${workerToDelete.name} (${workerToDelete.code}) from the worker list? They can be restored from Removed.`,
      confirmLabel: 'Remove worker',
    });
    if (!ok) return;
    const w = { ...workerToDelete, removedDate: selectedDate };
    setDeletedWorkers([...deletedWorkers, w]);
    setLaborData(laborData.filter((l: any) => l.id !== id));
    setDeleteConfirmId(null);
  };

  const handleRestoreWorker = (id: string) => {
    const w = deletedWorkers.find((w: any) => w.id === id);
    if (w) { setLaborData([...laborData, w]); setDeletedWorkers(deletedWorkers.filter((w: any) => w.id !== id)); }
  };

  const handlePermanentDelete = async (id: string) => {
    const ok = await destroyDialog({
      title: 'Delete permanently',
      message: 'Permanently delete this worker? Their attendance history is kept, but the worker cannot be restored.',
      confirmLabel: 'Delete permanently',
    });
    if (ok) setDeletedWorkers(deletedWorkers.filter((w: any) => w.id !== id));
  };

  const renderRecordSheet = () => {
    const [year, month] = selectedMonth.split('-').map(Number);
    const daysInMonth = new Date(year, month, 0).getDate();
    const dayInfo = Array.from({ length: daysInMonth }, (_, i) => { const day = i + 1; return { day, dateStr: `${selectedMonth}-${String(day).padStart(2, '0')}`, isWeekend: [0,6].includes(new Date(year, month - 1, day).getDay()) }; });
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead><tr className="bg-gray-50"><th className="sticky left-0 bg-gray-50 px-3 py-2 text-left font-semibold min-w-[200px]">Worker</th><th className="sticky left-[200px] bg-gray-50 px-3 py-2 text-left font-semibold min-w-[100px]">Code</th>{dayInfo.map(({day})=><th key={day} className={`px-2 py-2 text-center font-medium min-w-[40px] ${new Date(year,month-1,day).getDay()===0||new Date(year,month-1,day).getDay()===6?'bg-gray-100':''}`}><div>{day}</div><div className="text-[10px] text-gray-400">{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(year,month-1,day).getDay()]}</div></th>)}<th className="px-3 py-2 text-center font-semibold bg-blue-50 min-w-[60px]">P</th><th className="px-3 py-2 text-center font-semibold bg-red-50 min-w-[60px]">A</th><th className="px-3 py-2 text-center font-semibold bg-amber-50 min-w-[60px]">L</th><th className="px-3 py-2 text-center font-semibold bg-purple-50 min-w-[120px]">Monthly Salary</th></tr></thead>
          <tbody>{laborData.map((worker: any, idx: number) => {
            let presentDays=0, absentDays=0, leaveDays=0, totalOvertimeHours=0;
            return (
              <tr key={worker.id} className={idx%2===0?'bg-white':'bg-gray-50'}>
                <td className="sticky left-0 bg-inherit px-3 py-2 font-medium border-r whitespace-nowrap"><div className="flex items-center gap-2"><div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white ${worker.status==='present'?'bg-green-500':worker.status==='absent'?'bg-red-400':'bg-amber-400'}`}>{worker.name.split(' ').map((n: string) => n[0]).join('')}</div><span>{worker.name}</span></div></td>
                <td className="sticky left-[200px] bg-inherit px-3 py-2 border-r"><span className="font-mono text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded">{worker.code}</span></td>
                {dayInfo.map(({day,dateStr,isWeekend})=>{
                  const isNonWorking = nonWorkingDays.has(day);
                  const savedData = savedAttendance.get(dateStr);
                  const workerData = savedData?.find((d: any) => d.workerId === worker.id);
                  let status = '', bgColor = '';
                  if (isNonWorking) { status = 'NWD'; bgColor = 'bg-gray-300 text-gray-600'; }
                  else if (workerData) {
                    if (workerData.status === 'present') { status = 'P'; bgColor = 'bg-green-50 text-green-700'; presentDays++; totalOvertimeHours += workerData.overtimeHours; }
                    else if (workerData.status === 'absent') { status = 'A'; bgColor = 'bg-red-50 text-red-700'; absentDays++; }
                    else if (workerData.status === 'leave') { status = 'L'; bgColor = 'bg-amber-50 text-amber-700'; leaveDays++; }
                  } else if (isWeekend) { bgColor = 'bg-gray-100'; }
                  return <td key={day} className={`px-1 py-2 text-center border-r ${isWeekend&&!status?'bg-gray-100':''}`}>{status&&<span className={`inline-block w-6 h-6 leading-6 rounded text-xs font-bold ${bgColor}`}>{status}</span>}</td>;
                })}
                <td className="px-3 py-2 text-center font-semibold text-green-700 bg-green-50">{presentDays}</td>
                <td className="px-3 py-2 text-center font-semibold text-red-700 bg-red-50">{absentDays}</td>
                <td className="px-3 py-2 text-center font-semibold text-amber-700 bg-amber-50">{leaveDays}</td>
                <td className="px-3 py-2 text-center font-semibold text-purple-700 bg-purple-50">{formatCurrency(presentDays*worker.dailyWage + totalOvertimeHours*(worker.dailyWage/STANDARD_WORK_HOURS)*1.5)}</td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
    );
  };
  // Staff get their own sheet — never merged into the worker record.
  const renderStaffRecordSheet = () => {
    const [sYear, sMonth] = selectedMonth.split('-').map(Number);
    const daysInMonth = new Date(sYear, sMonth, 0).getDate();
    const dayInfo = Array.from({ length: daysInMonth }, (_, i) => {
      const day = i + 1;
      const dow = new Date(sYear, sMonth - 1, day).getDay();
      return { day, dateStr: `${selectedMonth}-${String(day).padStart(2, '0')}`, isWeekend: [0, 6].includes(dow) };
    });
    const summaries = staffSummaryForMonth(selectedMonth, staffList, staffStore);
    return (
      <div className="mt-6 border-t pt-6" data-testid="staff-record-sheet">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3">
          <div>
            <h3 className="text-lg font-semibold flex items-center gap-2"><Users className="w-5 h-5 text-indigo-500" /> Staff Record Sheet</h3>
            <p className="text-xs text-gray-500">Separate from the worker sheet · salary is the fixed monthly salary, never prorated by attendance.</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {summaries.some((s) => s.overLeaveLimit) && (
              <span className="text-xs font-medium text-red-700 bg-white border border-gray-200 border-l-2 border-l-red-600 px-2 py-1 rounded-full">
                Leave limit ({STAFF_LEAVE_LIMIT} days) exceeded
              </span>
            )}
            <button onClick={() => setPrintKind('staff')} data-testid="staff-print" className="flex items-center gap-1.5 bg-white border hover:bg-gray-50 text-gray-700 px-3 py-2 rounded-lg text-sm font-medium"><Printer className="w-4 h-4" /> Print</button>
            <button onClick={handleExportStaffExcel} data-testid="staff-export" className="flex items-center gap-1.5 bg-white border hover:bg-gray-50 text-gray-700 px-3 py-2 rounded-lg text-sm font-medium"><Download className="w-4 h-4" /> Export Excel</button>
          </div>
        </div>
        {summaries.length === 0 ? (
          <p className="text-sm text-gray-500 py-4">No staff for this job yet. Add staff in Staff Info.</p>
        ) : (
          <div className="overflow-x-auto border rounded">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="bg-indigo-50">
                  <th className="sticky left-0 bg-indigo-50 px-3 py-2 text-left font-semibold min-w-[200px]">Staff</th>
                  <th className="px-3 py-2 text-left font-semibold min-w-[100px]">Code</th>
                  {dayInfo.map(({ day }) => (
                    <th key={day} className="px-2 py-2 text-center font-medium min-w-[40px]">{day}</th>
                  ))}
                  <th className="px-3 py-2 text-center font-semibold bg-blue-50 min-w-[60px]">P</th>
                  <th className="px-3 py-2 text-center font-semibold bg-red-50 min-w-[60px]">A</th>
                  <th className="px-3 py-2 text-center font-semibold bg-amber-50 min-w-[60px]">L</th>
                  <th className="px-3 py-2 text-center font-semibold bg-purple-50 min-w-[120px]">Monthly Salary</th>
                </tr>
              </thead>
              <tbody>
                {summaries.map((s, idx) => (
                  <tr key={s.staff_id} className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                    <td className="sticky left-0 bg-inherit px-3 py-2 font-medium border-r whitespace-nowrap">{s.name}</td>
                    <td className="px-3 py-2 border-r"><span className="font-mono text-xs bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded">{s.code || '—'}</span></td>
                    {dayInfo.map(({ day, dateStr, isWeekend }) => {
                      const status = staffStatusIn(staffStore, dateStr, s.staff_id);
                      const label = status === 'present' ? 'P' : status === 'absent' ? 'A' : status === 'leave' ? 'L' : '';
                      const bg = status === 'present' ? 'bg-green-50 text-green-700' : status === 'absent' ? 'bg-red-50 text-red-700' : status === 'leave' ? 'bg-gray-900 text-white' : '';
                      return (
                        <td key={day} className={`px-1 py-2 text-center border-r ${isWeekend && !status ? 'bg-gray-100' : ''}`}>
                          {label && <span className={`inline-block w-6 h-6 leading-6 rounded text-xs font-bold ${bg}`}>{label}</span>}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 text-center font-semibold text-green-700 bg-green-50">{s.present}</td>
                    <td className="px-3 py-2 text-center font-semibold text-red-700 bg-red-50">{s.absent}</td>
                    <td className={`px-3 py-2 text-center font-semibold bg-amber-50 ${s.overLeaveLimit ? 'text-red-700' : 'text-amber-700'}`}>
                      {s.leave}{s.overLeaveLimit ? ' ⚠' : ''}
                    </td>
                    <td className="px-3 py-2 text-center font-semibold text-purple-700 bg-purple-50">{formatCurrency(s.salary)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-3 p-3 bg-indigo-50 border border-indigo-200 rounded-lg">
          <p className="text-xs text-indigo-800"><strong>Staff pay:</strong> the full monthly salary is paid whatever the P/A/L marks say — staff attendance is a record only. Leave allowance: {STAFF_LEAVE_LIMIT} days per month.</p>
        </div>
      </div>
    );
  };

  const [year, month] = selectedMonth.split('-').map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const goToPrevMonth = () => {
    const prev = new Date(year, month - 2, 1);
    setSelectedMonth(`${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`);
  };
  const goToNextMonth = () => {
    const next = new Date(year, month, 1);
    setSelectedMonth(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`);
  };

  function handleExportStaffExcel() {
    const [y, m] = selectedMonth.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const headerRow: any = { Staff: 'Staff', Code: 'Code' };
    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(y, m - 1, d).getDay();
      headerRow[`${d}\n${dayNames[dow]}`] = `${d}\n${dayNames[dow]}`;
    }
    headerRow['P'] = 'P';
    headerRow['A'] = 'A';
    headerRow['L'] = 'L';
    headerRow['Monthly Salary'] = 'Monthly Salary';
    const summaries = staffSummaryForMonth(selectedMonth, staffList, staffStore);
    const rows = summaries.map((s) => {
      const row: any = { Staff: s.name, Code: s.code };
      for (let d = 1; d <= daysInMonth; d++) {
        const dow = new Date(y, m - 1, d).getDay();
        const status = staffStatusIn(staffStore, `${selectedMonth}-${String(d).padStart(2, '0')}`, s.staff_id);
        row[`${d}\n${dayNames[dow]}`] = status === 'present' ? 'P' : status === 'absent' ? 'A' : status === 'leave' ? 'L' : '';
      }
      row['P'] = s.present;
      row['A'] = s.absent;
      row['L'] = s.leave;
      // Fixed monthly salary — never a proration of it.
      row['Monthly Salary'] = formatCurrency(s.salary);
      return row;
    });
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet([headerRow, ...rows], { skipHeader: true });
    ws['!cols'] = [{ wch: 25 }, { wch: 12 }, ...Array(daysInMonth).fill({ wch: 6 }), { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 18 }];
    if (!ws['!rows']) ws['!rows'] = [];
    ws['!rows'][0] = { hpt: 30 };
    XLSX.utils.book_append_sheet(wb, ws, 'Staff Attendance');
    const filename = `Staff_Attendance_Record_${new Date(`${selectedMonth}-01`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }).replace(' ', '_')}.xlsx`;
    try { XLSX.writeFile(wb, filename); } catch (e) { notify('Export failed.', 'error'); }
  }

  function handleExportMonthExcel() {
    const [y, m] = selectedMonth.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const headerRow: any = { Worker: 'Worker', Code: 'Code' };
    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(y, m - 1, d).getDay();
      headerRow[`${d}\n${dayNames[dow]}`] = `${d}\n${dayNames[dow]}`;
    }
    headerRow['P'] = 'P';
    headerRow['A'] = 'A';
    headerRow['L'] = 'L';
    headerRow['Monthly Salary'] = 'Monthly Salary';
    const buildWorkerRow = (w: any) => {
      const row: any = { Worker: w.name, Code: w.code };
      let p = 0, a = 0, lv = 0, ot = 0;
      for (let d = 1; d <= daysInMonth; d++) {
        const ds = `${selectedMonth}-${String(d).padStart(2, '0')}`;
        const dow2 = new Date(y, m - 1, d).getDay();
        const sd = savedAttendance.get(ds);
        const wd = sd?.find((d2: any) => d2.workerId === w.id);
        let st = '';
        if (wd) {
          if (wd.status === 'present') { st = 'P'; p++; ot += wd.overtimeHours; }
          else if (wd.status === 'absent') st = 'A';
          else if (wd.status === 'leave') st = 'L';
        }
        row[`${d}\n${dayNames[dow2]}`] = st;
      }
      row['P'] = p;
      row['A'] = a;
      row['L'] = lv;
      row['Monthly Salary'] = formatCurrency(p * w.dailyWage + ot * (w.dailyWage / STANDARD_WORK_HOURS) * 1.5);
      return row;
    };
    const excelData = [headerRow, ...laborData.map((w: any) => buildWorkerRow(w))];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(excelData, { skipHeader: true });
    ws['!cols'] = [{ wch: 25 }, { wch: 12 }, ...Array(daysInMonth).fill({ wch: 6 }), { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 18 }];
    if (!ws['!rows']) ws['!rows'] = [];
    ws['!rows'][0] = { hpt: 30 };
    XLSX.utils.book_append_sheet(wb, ws, 'Attendance Record');
    const filename = `Attendance_Record_${new Date(selectedMonth + '-01').toLocaleDateString('en-US', { month: 'long', year: 'numeric' }).replace(' ', '_')}.xlsx`;
    try { XLSX.writeFile(wb, filename); } catch (e) { notify('Export failed.', 'error'); }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div><h1>Worker Attendance</h1><p>{projectNameOf(getActiveProject())}</p><p className="text-xs text-indigo-600 font-medium">B.S. Today: {formatBS(getTodayBS())}</p></div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-white border rounded p-1">
            <button onClick={() => setViewMode('daily')} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium ${viewMode === 'daily' ? 'bg-amber-100 text-amber-800' : 'text-gray-500'}`}><List className="w-4 h-4"/> Daily View</button>
            <button onClick={() => setViewMode('record')} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium ${viewMode === 'record' ? 'bg-amber-100 text-amber-800' : 'text-gray-500'}`}><Table2 className="w-4 h-4"/> Record Sheet</button>
          </div>
          {deletedWorkers.length > 0 && <button onClick={() => setShowDeletedPanel(true)} className="flex items-center gap-1.5 bg-white border hover:bg-gray-50 text-gray-700 px-3 py-2 rounded-lg text-sm font-medium"><Trash2 className="w-4 h-4"/> Removed ({deletedWorkers.length})</button>}
          <button onClick={() => setShowAddLabor(true)} className="flex items-center gap-1.5 bg-gray-900 hover:bg-gray-800 text-white px-4 py-2 rounded-lg text-sm font-medium"><Plus className="w-4 h-4"/> Add Worker</button>
        </div>
      </div>

      {/* Staff attendance — its own section and its own store. Worker
          attendance (and labour payroll) is untouched by anything here. */}
      <div className="bg-white rounded-xl border p-4" data-testid="staff-attendance">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2"><Users className="w-5 h-5 text-indigo-500" /> Staff Attendance</h2>
            <p className="text-xs text-gray-500">Separate from worker attendance · fixed monthly salary, never reduced by attendance.</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <label htmlFor="staff-date" className="text-sm font-medium">Date:</label>
            <input id="staff-date" type="date" value={staffDate} onChange={(e) => setStaffDate(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            {staffList.length > 0 && (
              <button onClick={markAllStaffPresent} data-testid="staff-mark-all-present" className="flex items-center gap-1.5 bg-indigo-50 border border-indigo-200 hover:bg-indigo-100 text-indigo-700 px-3 py-2 rounded-lg text-sm font-medium"><CheckCircle2 className="w-4 h-4" /> Mark All Present</button>
            )}
          </div>
        </div>

        {staffOverLimit.length > 0 && (
          <div className="mt-3 p-3 bg-white border border-gray-200 border-l-2 border-l-amber-600 rounded-lg" data-testid="staff-leave-notice" role="status">
            <div className="flex items-center gap-2 text-sm font-medium text-amber-800"><AlertTriangle className="w-4 h-4" /> Over the {STAFF_LEAVE_LIMIT}-day leave allowance this month</div>
            <p className="text-xs text-amber-700 mt-1">{staffOverLimit.map((s) => `${s.name} (${s.leave} days)`).join(' · ')}</p>
          </div>
        )}

        {staffList.length === 0 ? (
          <p className="mt-4 text-sm text-gray-500">No staff for this job yet. Add staff in Staff Info.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
              <div className="bg-green-50 rounded-lg p-3"><p className="text-xs text-gray-600">Present</p><p className="text-xl font-bold text-green-700" data-testid="staff-present-count">{staffPresentCount}</p></div>
              <div className="bg-red-50 rounded-lg p-3"><p className="text-xs text-gray-600">Absent</p><p className="text-xl font-bold text-red-700" data-testid="staff-absent-count">{staffAbsentCount}</p></div>
              <div className="bg-amber-50 rounded-lg p-3"><p className="text-xs text-gray-600">On Leave</p><p className="text-xl font-bold text-amber-700" data-testid="staff-leave-count">{staffLeaveCount}</p></div>
              <div className="bg-gray-50 rounded-lg p-3"><p className="text-xs text-gray-600">Not marked</p><p className="text-xl font-bold text-gray-700" data-testid="staff-unmarked-count">{staffUnmarkedCount}</p></div>
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="bg-gray-50 border-b"><th className="px-4 py-3 text-left font-semibold">Staff</th><th className="px-4 py-3 text-left font-semibold">Code</th><th className="px-4 py-3 text-left font-semibold">Department</th><th className="px-4 py-3 text-center font-semibold">Status</th><th className="px-4 py-3 text-right font-semibold">Monthly Salary</th></tr></thead>
                <tbody className="divide-y">
                  {staffList.map((s: any) => {
                    const status = staffStatusIn(staffStore, staffDate, String(s.id));
                    const leaveCount = staffMonthSummary.find((x) => x.staff_id === String(s.id))?.leave || 0;
                    return (
                      <tr key={s.id} className={`hover:bg-gray-50 ${status === 'absent' ? 'opacity-60' : ''}`}>
                        <td className="px-4 py-3"><div className="flex items-center gap-2"><div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white ${status === 'present' ? 'bg-green-500' : status === 'absent' ? 'bg-red-400' : status === 'leave' ? 'bg-amber-400' : 'bg-indigo-400'}`}>{staffWorkerName(s).split(' ').map((n: string) => n[0]).join('').slice(0, 2)}</div><div><span className="font-medium">{staffWorkerName(s)}</span>{leaveCount > 0 && <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded ${leaveCount > STAFF_LEAVE_LIMIT ? 'bg-red-100 text-red-700' : 'bg-amber-50 text-amber-700'}`}>{leaveCount}L this month</span>}</div></div></td>
                        <td className="px-4 py-3"><span className="font-mono text-xs bg-indigo-50 text-indigo-700 px-2 py-1 rounded">{s.code || '—'}</span></td>
                        <td className="px-4 py-3"><span className="inline-flex px-2 py-0.5 bg-gray-100 text-gray-700 rounded text-xs font-medium">{s.department || s.jobTitle || '—'}</span></td>
                        <td className="px-4 py-3 text-center">
                          <button onClick={() => toggleStaffStatus(String(s.id))} data-testid={`staff-status-${s.id}`} className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${status === 'present' ? 'bg-green-100 text-green-700' : status === 'absent' ? 'bg-red-100 text-red-700' : status === 'leave' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-600'}`}>
                            {status === 'present' && <CheckCircle2 className="w-3 h-3" />}{status === 'absent' && <XCircle className="w-3 h-3" />}{status === 'leave' && <Coffee className="w-3 h-3" />}
                            {status === 'present' ? 'Present' : status === 'absent' ? 'Absent' : status === 'leave' ? 'On Leave' : 'Mark'}
                          </button>
                        </td>
                        <td className="px-4 py-3 text-right font-medium">{formatCurrency(staffMonthlySalary(s))}<div className="text-[10px] text-gray-400">fixed monthly</div></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      {viewMode === 'daily' ? (
        <>
          <div className="bg-white rounded-xl border p-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex items-center gap-3"><label className="text-sm font-medium">Attendance Date:</label><input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm" />{savedAttendance.has(selectedDate) && <span className="flex items-center gap-1 text-xs text-green-600 bg-green-50 px-2 py-1 rounded-full"><CheckCircle className="w-3 h-3"/> Saved</span>}</div>
              <button onClick={saveAttendance} className="flex items-center gap-2 bg-gray-900 hover:bg-gray-800 text-white px-4 py-2 rounded-lg text-sm font-medium"><Save className="w-4 h-4"/> Save Today's Attendance</button>
            </div>
            {showSaveConfirm && <div className="mt-3 p-3 bg-green-50 border border-green-200 rounded-lg flex items-center gap-2"><CheckCircle className="w-5 h-5 text-green-600"/><span className="text-sm text-green-700">Attendance saved successfully!</span></div>}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-white rounded-xl border p-4"><div className="flex items-center gap-2 mb-1"><CheckCircle2 className="w-4 h-4 text-green-500"/><span className="text-xs text-gray-500">Present</span></div><p className="text-2xl font-bold text-green-700">{presentCount}</p></div>
            <div className="bg-white rounded-xl border p-4"><div className="flex items-center gap-2 mb-1"><XCircle className="w-4 h-4 text-red-500"/><span className="text-xs text-gray-500">Absent</span></div><p className="text-2xl font-bold text-red-700">{absentCount}</p></div>
            <div className="bg-white rounded-xl border p-4"><div className="flex items-center gap-2 mb-1"><Coffee className="w-4 h-4 text-amber-500"/><span className="text-xs text-gray-500">On Leave</span></div><p className="text-2xl font-bold text-amber-700">{leaveCount}</p></div>
            <div className="bg-white rounded-xl border p-4"><div className="flex items-center gap-2 mb-1"><DollarSign className="w-4 h-4 text-blue-500"/><span className="text-xs text-gray-500">Est. Daily Cost</span></div><p className="text-2xl font-bold text-blue-700">{formatCurrency(totalDailyCost)}</p></div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={() => setLaborData(laborData.map((l: any) => ({ ...l, status: 'present', hoursWorked: STANDARD_WORK_HOURS, overtimeHours: 0 })))} className="flex items-center gap-1.5 bg-green-50 border border-green-200 hover:bg-green-100 text-green-700 px-3 py-2 rounded-lg text-sm font-medium"><CheckCircle2 className="w-4 h-4"/> Mark All Present</button>
            <button onClick={() => setLaborData(laborData.map((l: any) => ({ ...l, status: 'absent', hoursWorked: 0, overtimeHours: 0 })))} className="flex items-center gap-1.5 bg-white border border-gray-200 border-l-2 border-l-red-600 hover:bg-red-100 text-red-700 px-3 py-2 rounded-lg text-sm font-medium"><XCircle className="w-4 h-4"/> Mark All Absent</button>
            <button onClick={() => setLaborData(laborData.map((l: any) => ({ ...l, hoursWorked: 0, overtimeHours: 0 })))} className="flex items-center gap-1.5 bg-gray-50 border border-gray-200 hover:bg-gray-100 text-gray-700 px-3 py-2 rounded-lg text-sm font-medium">Reset Hours</button>
          </div>
          <div className="bg-white rounded-xl border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="bg-gray-50 border-b"><th className="px-4 py-3 text-left font-semibold">Worker</th><th className="px-4 py-3 text-left font-semibold">Code</th><th className="px-4 py-3 text-left font-semibold">Trade</th><th className="px-4 py-3 text-center font-semibold">Status</th><th className="px-4 py-3 text-right font-semibold">Hours</th><th className="px-4 py-3 text-right font-semibold">OT</th><th className="px-4 py-3 text-right font-semibold">Day Cost</th><th className="px-4 py-3 text-center font-semibold">Actions</th></tr></thead>
                <tbody className="divide-y">{laborData.map((l: any) => {
                  const dayCost = l.status === 'present' ? (l.hoursWorked / STANDARD_WORK_HOURS) * l.dailyWage + l.overtimeHours * (l.dailyWage / STANDARD_WORK_HOURS) * 1.5 : 0;
                  return <tr key={l.id} className={`hover:bg-gray-50 ${l.status === 'absent' ? 'opacity-50' : ''}`}>
                    <td className="px-4 py-3"><div className="flex items-center gap-2"><div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white ${l.status === 'present' ? 'bg-green-500' : l.status === 'absent' ? 'bg-red-400' : 'bg-amber-400'}`}>{l.name.split(' ').map((n: string) => n[0]).join('')}</div><span className="font-medium">{l.name}</span></div></td>
                    <td className="px-4 py-3"><span className="font-mono text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded">{l.code}</span></td>
                    <td className="px-4 py-3"><span className="inline-flex px-2 py-0.5 bg-gray-100 text-gray-700 rounded text-xs font-medium">{l.trade}</span></td>
                    <td className="px-4 py-3 text-center"><button onClick={() => toggleStatus(l.id)} className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${l.status === 'present' ? 'bg-green-100 text-green-700' : l.status === 'absent' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>{l.status === 'present' && <CheckCircle2 className="w-3 h-3"/>}{l.status === 'absent' && <XCircle className="w-3 h-3"/>}{l.status === 'leave' && <Coffee className="w-3 h-3"/>}{l.status.charAt(0).toUpperCase() + l.status.slice(1)}</button></td>
                    <td className="px-4 py-3 text-right"><input type="number" value={l.hoursWorked} onChange={(e) => updateWorkerField(l.id, 'hoursWorked', parseFloat(e.target.value) || 0)} disabled={l.status !== 'present'} className="w-16 text-right border border-gray-200 rounded px-2 py-1 text-sm disabled:bg-gray-50" min="0" max="24" step="0.5" /></td>
                    <td className="px-4 py-3 text-right"><input type="number" value={l.overtimeHours} onChange={(e) => updateWorkerField(l.id, 'overtimeHours', parseFloat(e.target.value) || 0)} disabled={l.status !== 'present'} className="w-16 text-right border border-gray-200 rounded px-2 py-1 text-sm disabled:bg-gray-50" min="0" max="12" step="0.5" /></td>
                    <td className="px-4 py-3 text-right font-medium">{formatCurrency(dayCost)}</td>
                    <td className="px-4 py-3 text-center"><button onClick={() => setDeleteConfirmId(l.id)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors" title="Remove Worker"><Trash2 className="w-4 h-4"/></button></td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="bg-white rounded-xl border p-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
              <div className="flex items-center gap-3"><label className="text-sm font-medium">Select Month:</label>
                <div className="flex items-center gap-2">
                  <button onClick={goToPrevMonth} className="p-2 hover:bg-gray-100 rounded" title="Previous Month"><ChevronLeft className="w-4 h-4 text-gray-600"/></button>
                  <input type="month" value={selectedMonth} onChange={(e) => setSelectedMonth(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                  <button onClick={goToNextMonth} className="p-2 hover:bg-gray-100 rounded" title="Next Month"><ChevronRight className="w-4 h-4 text-gray-600"/></button>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="text-xs text-gray-500 mr-4">
                  <span className="inline-block w-3 h-3 bg-green-500 rounded mr-1"></span>P
                  <span className="inline-block w-3 h-3 bg-red-500 rounded ml-2 mr-1"></span>A
                  <span className="inline-block w-3 h-3 bg-amber-500 rounded ml-2 mr-1"></span>L
                  <span className="inline-block w-3 h-3 bg-gray-300 rounded ml-2 mr-1"></span>NWD
                </div>
                <button onClick={() => setPrintKind('workers')} data-testid="worker-print" className="flex items-center gap-1.5 bg-white border hover:bg-gray-50 text-gray-700 px-3 py-2 rounded-lg text-sm font-medium"><Printer className="w-4 h-4"/> Print</button>
                <button onClick={handleExportMonthExcel} className="flex items-center gap-1.5 bg-white border hover:bg-gray-50 text-gray-700 px-3 py-2 rounded-lg text-sm font-medium"><Download className="w-4 h-4"/> Export Excel</button>
              </div>
            </div>
            {renderRecordSheet()}
            {renderStaffRecordSheet()}
            {deletedWorkers.length > 0 && <div className="mt-6"><h3 className="text-lg font-semibold flex items-center gap-2"><Trash2 className="w-5 h-5 text-red-500"/> Workers Who Left</h3><div className="overflow-x-auto border rounded"><table className="w-full text-xs border-collapse"><thead><tr className="bg-gray-100"><th className="sticky left-0 bg-gray-100 px-3 py-2 text-left font-semibold min-w-[200px]">Worker</th><th className="sticky left-[200px] bg-gray-100 px-3 py-2 text-left font-semibold min-w-[100px]">Code</th>{Array.from({ length: daysInMonth }, (_, i) => { const d = i + 1; const dow = new Date(year, month - 1, d).getDay(); return <th key={d} className="px-2 py-2 text-center font-medium min-w-[40px]"><div>{d}</div><div className="text-[10px] text-gray-400">{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow]}</div></th> }).concat(<th className="px-3 py-2 text-center font-semibold bg-blue-50 min-w-[60px]">P</th>, <th className="px-3 py-2 text-center font-semibold bg-red-50 min-w-[60px]">A</th>, <th className="px-3 py-2 text-center font-semibold bg-amber-50 min-w-[60px]">L</th>, <th className="px-3 py-2 text-center font-semibold bg-purple-50 min-w-[120px]">Monthly Salary</th>)}</tr></thead><tbody>{deletedWorkers.map((w: any, idx: number) => { let p = 0, a = 0, lv = 0, ot = 0; return <tr key={w.id} className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}><td className="sticky left-0 bg-inherit px-3 py-2 font-medium border-r whitespace-nowrap"><div className="flex items-center gap-2"><div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white bg-red-500">{w.name.split(' ').map((n: string) => n[0]).join('')}</div><div><span>{w.name}</span>{w.removedDate && <div className="text-[10px] text-red-600">Left: {new Date(w.removedDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>}</div></div></td><td className="sticky left-[200px] bg-inherit px-3 py-2 border-r"><span className="font-mono text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded">{w.code}</span></td>{Array.from({ length: daysInMonth }, (_, i) => { const d = i + 1; const ds = `${selectedMonth}-${String(d).padStart(2, '0')}`; const dow = new Date(year, month - 1, d).getDay(); const isWend = new Date(year, month - 1, d).getDay() === 0 || new Date(year, month - 1, d).getDay() === 6; const isNWD = nonWorkingDays.has(d); const isAfter = w.removedDate && ds > w.removedDate; const sd = savedAttendance.get(ds); const wd = sd?.find((d2: any) => d2.workerId === w.id); let st = '', bc = ''; if (isAfter) { st = 'LFT'; bc = 'bg-red-100 text-red-600'; } else if (isNWD) { st = 'NWD'; bc = 'bg-gray-300 text-gray-600'; } else if (wd) { if (wd.status === 'present') { st = 'P'; bc = 'bg-green-50 text-green-700'; p++; ot += wd.overtimeHours; } else if (wd.status === 'absent') { st = 'A'; bc = 'bg-red-50 text-red-700'; a++; } else if (wd.status === 'leave') { st = 'L'; bc = 'bg-amber-50 text-amber-700'; lv++; } } else if (isWend) { bc = 'bg-gray-100'; } return <td key={d} className="px-1 py-2 text-center border-r">{st && <span className={`inline-block w-6 h-6 leading-6 rounded text-xs font-bold ${bc}`}>{st}</span>}</td>; }).concat(<td className="px-3 py-2 text-center font-semibold text-green-700 bg-green-50">{p}</td>, <td className="px-3 py-2 text-center font-semibold text-red-700 bg-red-50">{a}</td>, <td className="px-3 py-2 text-center font-semibold text-amber-700 bg-amber-50">{lv}</td>, <td className="px-3 py-2 text-center font-semibold text-purple-700 bg-purple-50">{formatCurrency(p * w.dailyWage + ot * (w.dailyWage / STANDARD_WORK_HOURS) * 1.5)}</td>)}</tr>; })}</tbody></table></div></div>}
            <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-lg"><p className="text-xs text-blue-800"><strong>Legend:</strong> P = Present, A = Absent, L = Leave, LFT = Left, NWD = Non-Working Day.</p></div>
          </div>
        </>
      )}
      {printKind && (
        <Modal
          isOpen
          onClose={() => setPrintKind(null)}
          size="full"
          title={`${printKind === 'staff' ? 'Staff' : 'Worker'} attendance — ${selectedMonth}`}
          description="This is the sheet that prints — same markup, same figures."
        >
          <div className="space-y-3">
            <div className="flex justify-end gap-2 no-print">
              <button
                type="button"
                onClick={() =>
                  void printSheet(printRef.current, {
                    title: `${printKind === 'staff' ? 'Staff' : 'Worker'} Attendance ${selectedMonth}`,
                    landscape: true,
                  })
                }
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-gray-900 hover:bg-gray-800 rounded-lg"
                data-testid="attendance-print-run"
              >
                <Printer className="w-4 h-4" /> Print / PDF
              </button>
              <button type="button" onClick={() => setPrintKind(null)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600">
                <X className="w-4 h-4" /> Close
              </button>
            </div>
            <div className="overflow-x-auto">
              <div ref={printRef}>
                {printKind === 'staff' ? (
                  <StaffAttendanceSheet
                    month={selectedMonth}
                    project={projectNameOf(getActiveProject())}
                    rows={staffSummaryForMonth(selectedMonth, staffList, staffStore)}
                    statusOn={(dateStr, staffId) => staffStatusIn(staffStore, dateStr, staffId)}
                  />
                ) : (
                  <WorkerAttendanceSheet
                    month={selectedMonth}
                    project={projectNameOf(getActiveProject())}
                    workers={laborData.map((w: any) => ({
                      id: String(w.id),
                      name: String(w.name || ''),
                      code: String(w.code || ''),
                      dailyWage: Number(w.dailyWage) || 0,
                    }))}
                    nonWorkingDays={nonWorkingDays}
                    statusOn={(dateStr, workerId) => {
                      const row = savedAttendance
                        .get(dateStr)
                        ?.find((r: any) => String(r.workerId ?? r.worker_id) === workerId);
                      if (!row) return null;
                      return {
                        status: String(row.status || ''),
                        overtimeHours: Number(row.overtimeHours ?? row.ot_hours) || 0,
                      };
                    }}
                  />
                )}
              </div>
            </div>
          </div>
        </Modal>
      )}
      <AddLaborModal isOpen={showAddLabor} onClose={() => setShowAddLabor(false)} newLabor={newLabor} setNewLabor={setNewLabor} onSave={addLaborer} />
      {deleteConfirmId && <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setDeleteConfirmId(null)}><div className="bg-white rounded-2xl max-w-md w-full" onClick={e => e.stopPropagation()}><div className="p-6"><div className="flex items-center gap-3 mb-4"><div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center"><AlertTriangle className="w-6 h-6 text-red-600"/></div><div><h3 className="text-lg font-bold">Remove Worker?</h3><p className="text-sm text-gray-500">You can restore this worker later if needed.</p></div></div><div className="bg-gray-50 rounded-lg p-3 mb-4">{(() => { const w = laborData.find((l: any) => l.id === deleteConfirmId); if (!w) return null; return (<div><p className="text-sm font-medium">{w.name}</p><p className="text-xs text-gray-600 mt-1">Code: {w.code}</p><p className="text-xs text-gray-600">Trade: {w.trade}</p><p className="text-xs text-gray-600">Daily Wage: {formatCurrency(w.dailyWage)}</p></div>); })()}</div><div className="flex justify-end gap-2"><button onClick={() => setDeleteConfirmId(null)} className="px-4 py-2 text-sm text-gray-600">Cancel</button><button onClick={() => void handleDeleteWorker(deleteConfirmId!)} className="px-4 py-2 text-sm bg-red-50 text-red-700 rounded-lg hover:bg-red-600 font-medium">Remove Worker</button></div></div></div></div>}
      {showDeletedPanel && deletedWorkers.length > 0 && <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowDeletedPanel(false)}><div className="bg-white rounded-2xl max-w-2xl w-full max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}><div className="p-6 border-b flex items-center justify-between"><div><h3 className="text-lg font-bold">Recently Removed Workers</h3><p className="text-sm text-gray-500 mt-1">Restore or permanently delete removed workers</p></div><button onClick={() => setShowDeletedPanel(false)} className="p-2 hover:bg-gray-100 rounded"><X className="w-5 h-5"/></button></div><div className="p-6 overflow-y-auto flex-1"><div className="space-y-3">{deletedWorkers.map((w: any) => (<div key={w.id} className="p-4 rounded-lg border bg-gray-50"><div className="flex items-start justify-between mb-2"><div className="flex items-center gap-3 flex-1"><div className="w-10 h-10 rounded-full bg-gray-900 flex items-center justify-center text-white font-bold text-sm">{w.name.split(' ').map((n: string) => n[0]).join('')}</div><div className="flex-1"><p className="text-sm font-medium">{w.name}</p><div className="flex items-center gap-2 mt-1"><span className="text-xs font-mono bg-blue-50 text-blue-700 px-2 py-0.5 rounded">{w.code}</span><span className="text-xs text-gray-600">{w.trade}</span></div></div></div></div><div className="grid grid-cols-2 gap-3 mb-3 text-xs"><div><p className="text-gray-500">Daily Wage</p><p className="font-medium">{formatCurrency(w.dailyWage)}</p></div><div><p className="text-gray-500">Status</p><p className="font-medium capitalize">{w.status}</p></div></div><div className="flex items-center gap-2 pt-3 border-t"><button onClick={() => handleRestoreWorker(w.id)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-green-50 text-green-700 rounded-lg hover:bg-green-100 font-medium"><CheckCircle className="w-3.5 h-3.5"/> Restore Worker</button><button onClick={() => handlePermanentDelete(w.id)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-red-50 text-red-700 rounded-lg hover:bg-red-100 font-medium"><Trash2 className="w-3.5 h-3.5"/> Permanent Delete</button></div></div>))}</div></div></div></div>}
    </div>
  );
}

function AddLaborModal({ isOpen, onClose, newLabor, setNewLabor, onSave }: any) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-md w-full" onClick={e => e.stopPropagation()}>
        <div className="p-6 border-b flex items-center justify-between"><h3 className="text-lg font-bold">Add New Worker</h3><button onClick={onClose} className="p-2 hover:bg-gray-100 rounded"><X className="w-5 h-5"/></button></div>
        <div className="p-6 space-y-4">
          <div><label className="block text-sm font-medium text-gray-700 mb-1">Worker Code</label><input type="text" value={newLabor.code} onChange={e => setNewLabor({ ...newLabor, code: e.target.value })} placeholder="e.g., WKR-005 (auto-generated if empty)" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono" /></div>
          <div><label className="block text-sm font-medium text-gray-700 mb-1">Name</label><input type="text" value={newLabor.name} onChange={e => setNewLabor({ ...newLabor, name: e.target.value })} placeholder="Full name" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
          <div><label className="block text-sm font-medium text-gray-700 mb-1">Trade</label><input type="text" list="trade-options" value={newLabor.trade} onChange={e => setNewLabor({ ...newLabor, trade: e.target.value })} placeholder="e.g., Mason, Welder..." className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /><datalist id="trade-options"><option value="Mason"/><option value="Steel Fixer"/><option value="Carpenter"/><option value="Helper"/><option value="Electrician"/><option value="Plumber"/><option value="Welder"/><option value="Painter"/><option value="Driver"/><option value="Supervisor"/><option value="Foreman"/><option value="Operator"/></datalist></div>
          <div><label className="block text-sm font-medium text-gray-700 mb-1">Daily Wage (NRS)</label><input type="number" value={newLabor.dailyWage} onChange={e => setNewLabor({ ...newLabor, dailyWage: e.target.value })} placeholder="0" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" /></div>
          <div className="flex justify-end gap-2 pt-4"><button onClick={onClose} className="px-4 py-2 text-sm text-gray-600">Cancel</button><button onClick={onSave} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-800 font-medium">Add Worker</button></div>
        </div>
      </div>
    </div>
  );
}
