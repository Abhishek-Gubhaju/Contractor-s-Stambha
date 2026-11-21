// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import Dashboard from './Dashboard';
import { writeScoped } from '../services/projectScope';
import { STAFF_ATTENDANCE_KEY, STAFF_LEAVE_LIMIT, STAFF_KEY } from '../services/staffAttendanceService';
import { getCurrentMonthInTimezone } from '../utils';

const TZ = 'Asia/Kathmandu';

const staff = [{ id: 's1', code: 'STF-001', firstName: 'Anita', lastName: 'Rai', monthlySalary: 55000 }];

function leaveDays(count: number) {
  const ym = getCurrentMonthInTimezone(TZ);
  const days: Record<string, any> = {};
  for (let n = 1; n <= count; n++) {
    days[`${ym}-${String(n).padStart(2, '0')}`] = { rows: [{ staff_id: 's1', status: 'leave' }] };
  }
  return days;
}

const renderDashboard = () =>
  render(<Dashboard poData={[]} timezone={TZ} boqData={[]} laborData={[]} dsrData={[]} />);

describe('Dashboard staff leave alert', () => {
  beforeEach(() => {
    localStorage.clear();
    writeScoped(STAFF_KEY, staff);
  });

  it('stays quiet at the allowance', () => {
    writeScoped(STAFF_ATTENDANCE_KEY, leaveDays(STAFF_LEAVE_LIMIT));
    renderDashboard();
    expect(screen.queryByTestId('staff-leave-alert')).toBeNull();
  });

  it('alerts once a staff member crosses the allowance', () => {
    writeScoped(STAFF_ATTENDANCE_KEY, leaveDays(STAFF_LEAVE_LIMIT + 1));
    renderDashboard();
    const alert = screen.getByTestId('staff-leave-alert');
    expect(alert.textContent).toContain('Anita Rai');
    expect(alert.textContent).toContain(`${STAFF_LEAVE_LIMIT + 1} days`);
    expect(alert.textContent).toContain('salary is unchanged');
  });

  it('ignores leave from other months', () => {
    const other: Record<string, any> = {};
    for (let n = 1; n <= STAFF_LEAVE_LIMIT + 2; n++) {
      other[`2020-01-${String(n).padStart(2, '0')}`] = { rows: [{ staff_id: 's1', status: 'leave' }] };
    }
    writeScoped(STAFF_ATTENDANCE_KEY, other);
    renderDashboard();
    expect(screen.queryByTestId('staff-leave-alert')).toBeNull();
  });
});
