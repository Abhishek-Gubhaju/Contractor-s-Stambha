// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AttendancePage from './Attendance';
import { loadAttendance } from '../services/labourService';
import { getCurrentDateInTimezone } from '../utils';

const workers = [
  { id: '1', code: 'WKR-001', name: 'Rajesh Kumar', trade: 'Mason', dailyWage: 1200, status: 'present', hoursWorked: 10, overtimeHours: 2, assignedBOQItem: '' },
  { id: '2', code: 'WKR-002', name: 'Suresh Patel', trade: 'Mason', dailyWage: 1200, status: 'absent', hoursWorked: 0, overtimeHours: 0, assignedBOQItem: '' },
];

const TZ = 'Asia/Kathmandu';

describe('Attendance persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('writes saved days to the shared attendance store', () => {
    render(<AttendancePage laborData={workers} setLaborData={vi.fn()} timezone={TZ} />);

    fireEvent.click(screen.getByText(/Save Today's Attendance/i));

    const stored = JSON.parse(localStorage.getItem('contractoros_attendance::PRJ-001') || '{}');
    const today = getCurrentDateInTimezone(TZ);
    expect(stored[today]).toBeTruthy();
    expect(stored[today].rows).toHaveLength(2);
    expect(stored[today].rows[0]).toMatchObject({ worker_id: '1', status: 'present', ot_hours: 2 });
  });

  it('round-trips through labourService.loadAttendance', () => {
    render(<AttendancePage laborData={workers} setLaborData={vi.fn()} timezone={TZ} />);
    fireEvent.click(screen.getByText(/Save Today's Attendance/i));

    const rows = loadAttendance();
    expect(rows).toHaveLength(2);
    const rajesh = rows.find((r) => r.worker_id === '1');
    expect(rajesh?.status).toBe('present');
    expect(rajesh?.ot_hours).toBe(2);
    expect(rajesh?.date).toBe(getCurrentDateInTimezone(TZ));
  });
});
