// ============================================================================
// staffAttendanceService — attendance for STAFF, kept apart from workers.
//
// Two reasons this is a separate store (`contractoros_staff_attendance`):
//   • worker attendance (contractoros_attendance) is the ONLY source of labour
//     earnings, so staff must never leak into wage calculations;
//   • a staff member is paid a fixed monthly salary — their attendance is a
//     record of presence and leave, not a pay multiplier.
//
// A staff member may take up to STAFF_LEAVE_LIMIT leave days in a month; going
// over that raises the dashboard alert. Nothing here alters salary.
// ============================================================================
import { readScoped } from './projectScope';
import { staffWorkerName } from './labourService';

export const STAFF_ATTENDANCE_KEY = 'contractoros_staff_attendance';
export const STAFF_KEY = 'contractoros_staff';
/** Leave allowed per staff member per month before the dashboard alert. */
export const STAFF_LEAVE_LIMIT = 4;

export type StaffAttendanceStatus = 'present' | 'absent' | 'leave';

export interface StaffAttendanceRow {
  staff_id: string;
  status: StaffAttendanceStatus;
}

export interface StaffAttendanceSummary {
  staff_id: string;
  code: string;
  name: string;
  department: string;
  present: number;
  absent: number;
  leave: number;
  /** Fixed monthly salary — never prorated by attendance. */
  salary: number;
  overLeaveLimit: boolean;
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export function normalizeStaffStatus(value: unknown): StaffAttendanceStatus {
  return value === 'absent' || value === 'leave' ? value : 'present';
}

/** Rows saved for one day, in both the old array and the { rows } shape. */
export function staffRowsOn(store: Record<string, any> | null | undefined, date: string): StaffAttendanceRow[] {
  const value = store?.[date];
  const list = Array.isArray(value) ? value : value && Array.isArray(value.rows) ? value.rows : [];
  const rows: StaffAttendanceRow[] = [];
  for (const r of list) {
    if (!r) continue;
    const staffId = String((r as any).staff_id ?? (r as any).staffId ?? '');
    if (!staffId) continue;
    rows.push({ staff_id: staffId, status: normalizeStaffStatus((r as any).status) });
  }
  return rows;
}

export function staffStatusIn(store: Record<string, any> | null | undefined, date: string, staffId: string): StaffAttendanceStatus | '' {
  const row = staffRowsOn(store, date).find((r) => r.staff_id === staffId);
  return row ? row.status : '';
}

export function monthPrefixOf(dateISO: string): string {
  return String(dateISO || '').slice(0, 7);
}

/** The staff master for the active job (the Staff Info page's own records). */
export function loadStaffRecords(): any[] {
  const rows = readScoped<any[]>(STAFF_KEY, []);
  return Array.isArray(rows) ? rows : [];
}

export function loadStaffAttendanceStore(): Record<string, any> {
  const store = readScoped<Record<string, any>>(STAFF_ATTENDANCE_KEY, {});
  return store && typeof store === 'object' ? store : {};
}

/**
 * The store as a flat day → rows map, tolerant of every shape written so far.
 */
export function loadStaffAttendance(): Record<string, StaffAttendanceRow[]> {
  const store = loadStaffAttendanceStore();
  const out: Record<string, StaffAttendanceRow[]> = {};
  for (const date of Object.keys(store)) {
    const rows = staffRowsOn(store, date);
    if (rows.length > 0) out[date] = rows;
  }
  return out;
}

/** A staff member's fixed monthly salary — attendance never changes it. */
export function staffMonthlySalary(staff: any): number {
  return round2(staff?.monthlySalary);
}

/**
 * Present / absent / leave counts for one A.D. month (`YYYY-MM`), with the
 * fixed salary carried through untouched.
 */
export function staffSummaryForMonth(
  monthPrefix: string,
  staffList: any[],
  store?: Record<string, any> | null
): StaffAttendanceSummary[] {
  const attendance = store ? Object.fromEntries(Object.keys(store).map((date) => [date, staffRowsOn(store, date)])) : loadStaffAttendance();
  const summaries: StaffAttendanceSummary[] = (staffList || [])
    .filter((s) => s && s.id !== undefined && s.id !== null)
    .map((s) => ({
      staff_id: String(s.id),
      code: String(s.code || ''),
      name: staffWorkerName(s),
      department: String(s.department || s.jobTitle || ''),
      present: 0,
      absent: 0,
      leave: 0,
      salary: staffMonthlySalary(s),
      overLeaveLimit: false,
    }));
  const byId = new Map(summaries.map((s) => [s.staff_id, s]));

  for (const [date, rows] of Object.entries(attendance)) {
    if (!date.startsWith(monthPrefix)) continue;
    for (const row of rows) {
      const summary = byId.get(row.staff_id);
      if (!summary) continue;
      if (row.status === 'present') summary.present += 1;
      else if (row.status === 'absent') summary.absent += 1;
      else summary.leave += 1;
    }
  }

  for (const summary of summaries) summary.overLeaveLimit = summary.leave > STAFF_LEAVE_LIMIT;
  return summaries;
}

/** Staff who have gone over the leave allowance in that month. */
export function staffOverLeaveLimit(monthPrefix: string, staffList?: any[], store?: Record<string, any> | null): StaffAttendanceSummary[] {
  return staffSummaryForMonth(monthPrefix, staffList || loadStaffRecords(), store)
    .filter((s) => s.overLeaveLimit)
    .sort((a, b) => b.leave - a.leave);
}
