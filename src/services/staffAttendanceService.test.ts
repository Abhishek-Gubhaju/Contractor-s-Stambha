// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { readScoped, writeScoped } from './projectScope';
import { loadAttendance } from './labourService';
import {
  STAFF_ATTENDANCE_KEY,
  STAFF_LEAVE_LIMIT,
  loadStaffAttendance,
  staffMonthlySalary,
  staffOverLeaveLimit,
  staffRowsOn,
  staffStatusIn,
  staffSummaryForMonth,
} from './staffAttendanceService';

const staff = [
  { id: 's1', code: 'STF-001', firstName: 'Anita', lastName: 'Rai', monthlySalary: 55000, department: 'Accounts' },
  { id: 's2', code: 'STF-002', firstName: 'Bikash', lastName: 'Rai', monthlySalary: 48000, department: 'Site' },
];

const day = (n: number) => `2025-04-${String(n).padStart(2, '0')}`;

function saveDay(date: string, rows: { staff_id: string; status: string }[]) {
  const store = readScoped<Record<string, any>>(STAFF_ATTENDANCE_KEY, {});
  writeScoped(STAFF_ATTENDANCE_KEY, { ...store, [date]: { rows } });
}

beforeEach(() => {
  localStorage.clear();
});

describe('staff attendance store', () => {
  it('round-trips a day through its own key', () => {
    saveDay(day(3), [
      { staff_id: 's1', status: 'present' },
      { staff_id: 's2', status: 'leave' },
    ]);

    const raw = JSON.parse(localStorage.getItem('contractoros_staff_attendance::PRJ-001') || '{}');
    expect(raw[day(3)].rows).toHaveLength(2);

    const loaded = loadStaffAttendance();
    expect(loaded[day(3)]).toEqual([
      { staff_id: 's1', status: 'present' },
      { staff_id: 's2', status: 'leave' },
    ]);
    expect(staffStatusIn(loadStaffAttendance(), day(3), 's2')).toBe('leave');
  });

  it('tolerates the old bare-array day shape', () => {
    writeScoped(STAFF_ATTENDANCE_KEY, { [day(4)]: [{ staff_id: 's1', status: 'absent' }] });
    expect(staffRowsOn(loadStaffAttendance(), day(4))).toEqual([{ staff_id: 's1', status: 'absent' }]);
  });
});

describe('staff leave summary', () => {
  it('counts present / absent / leave for the requested month only', () => {
    saveDay(day(1), [{ staff_id: 's1', status: 'present' }]);
    saveDay(day(2), [{ staff_id: 's1', status: 'present' }]);
    saveDay(day(3), [{ staff_id: 's1', status: 'absent' }]);
    saveDay(day(4), [{ staff_id: 's1', status: 'leave' }]);
    saveDay('2025-05-01', [{ staff_id: 's1', status: 'present' }]);

    const [anita, bikash] = staffSummaryForMonth('2025-04', staff, loadStaffAttendance());
    expect(anita).toMatchObject({ present: 2, absent: 1, leave: 1, salary: 55000, overLeaveLimit: false });
    expect(bikash).toMatchObject({ present: 0, absent: 0, leave: 0, salary: 48000 });
  });

  it(`allows ${STAFF_LEAVE_LIMIT} leave days and flags the next one`, () => {
    for (let n = 1; n <= STAFF_LEAVE_LIMIT; n++) saveDay(day(n), [{ staff_id: 's1', status: 'leave' }]);
    let summary = staffSummaryForMonth('2025-04', staff, loadStaffAttendance());
    expect(summary[0].leave).toBe(STAFF_LEAVE_LIMIT);
    expect(summary[0].overLeaveLimit).toBe(false);

    saveDay(day(STAFF_LEAVE_LIMIT + 1), [{ staff_id: 's1', status: 'leave' }]);
    summary = staffSummaryForMonth('2025-04', staff, loadStaffAttendance());
    expect(summary[0].leave).toBe(STAFF_LEAVE_LIMIT + 1);
    expect(summary[0].overLeaveLimit).toBe(true);
    expect(summary[1].overLeaveLimit).toBe(false);

    const alerts = staffOverLeaveLimit('2025-04', staff, loadStaffAttendance());
    expect(alerts.map((s) => s.staff_id)).toEqual(['s1']);
  });

  it('never prorates the monthly salary by attendance', () => {
    for (let n = 1; n <= 10; n++) saveDay(day(n), [{ staff_id: 's1', status: n === 1 ? 'present' : 'absent' }]);
    const [anita] = staffSummaryForMonth('2025-04', staff, loadStaffAttendance());
    expect(anita.salary).toBe(55000);
    expect(staffMonthlySalary({ monthlySalary: 55000 })).toBe(55000);
    expect(staffMonthlySalary({})).toBe(0);
  });

  it('stays completely separate from worker attendance', () => {
    saveDay(day(1), [{ staff_id: 's1', status: 'present' }]);
    expect(readScoped('contractoros_attendance', {})).toEqual({});
    expect(loadAttendance()).toEqual([]);

    writeScoped('contractoros_attendance', {
      [day(2)]: { project_id: 'PRJ-001', rows: [{ worker_id: 'w1', status: 'present' }] },
    });
    const loaded = loadStaffAttendance();
    expect(loaded[day(2)]).toBeUndefined();
    expect(loaded[day(1)]).toHaveLength(1);
    expect(loadAttendance()).toHaveLength(1);
  });
});
