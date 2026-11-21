// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import AttendancePage from './Attendance';
import { loadAttendance } from '../services/labourService';
import { readScoped } from '../services/projectScope';
import { formatCurrency, getCurrentDateInTimezone } from '../utils';
import * as XLSX from 'xlsx';

vi.mock('xlsx', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, writeFile: vi.fn() };
});

const workers = [
  { id: '1', code: 'WKR-001', name: 'Rajesh Kumar', trade: 'Mason', dailyWage: 1200, status: 'present', hoursWorked: 10, overtimeHours: 2, assignedBOQItem: '' },
];

const staff = [
  { id: 's1', code: 'STF-001', firstName: 'Anita', lastName: 'Rai', monthlySalary: 55000, department: 'Accounts' },
  { id: 's2', code: 'STF-002', firstName: 'Bikash', lastName: 'Rai', monthlySalary: 48000, department: 'Site' },
];

const TZ = 'Asia/Kathmandu';
const renderPage = () =>
  render(<AttendancePage laborData={workers} setLaborData={vi.fn()} timezone={TZ} staffData={staff} />);

describe('Staff attendance section', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('shows the staff list in its own section above the worker table', () => {
    renderPage();
    const section = screen.getByTestId('staff-attendance');
    expect(within(section).getByText('Anita Rai')).toBeTruthy();
    expect(within(section).getByText('Bikash Rai')).toBeTruthy();
    expect(within(section).getByText(formatCurrency(55000))).toBeTruthy();
    // Worker attendance still renders its own table.
    expect(screen.getByText('Rajesh Kumar')).toBeTruthy();
    expect(screen.getByText(/Save Today's Attendance/i)).toBeTruthy();
  });

  it('records staff status in the staff store only, never in worker attendance', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('staff-status-s1'));

    const staffStore = readScoped<any>('contractoros_staff_attendance', {});
    const today = getCurrentDateInTimezone(TZ);
    expect(staffStore[today].rows).toEqual([{ staff_id: 's1', status: 'present' }]);

    // Worker attendance stays empty until the worker save button is used.
    expect(readScoped('contractoros_attendance', {})).toEqual({});
    expect(loadAttendance()).toEqual([]);
  });

  it('cycles present → absent → leave and keeps the fixed salary visible', () => {
    renderPage();
    const button = screen.getByTestId('staff-status-s2');

    fireEvent.click(button);
    expect(button.textContent).toContain('Present');
    fireEvent.click(button);
    expect(button.textContent).toContain('Absent');
    fireEvent.click(button);
    expect(button.textContent).toContain('On Leave');

    expect(within(screen.getByTestId('staff-attendance')).getAllByText(formatCurrency(48000)).length).toBeGreaterThan(0);
  });

  it('marks all staff present', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('staff-mark-all-present'));
    const today = getCurrentDateInTimezone(TZ);
    const store = readScoped<any>('contractoros_staff_attendance', {});
    expect(store[today].rows).toHaveLength(2);
    expect(store[today].rows.every((r: any) => r.status === 'present')).toBe(true);
  });

  it('keeps worker attendance saving unchanged', () => {
    renderPage();
    fireEvent.click(screen.getByText(/Save Today's Attendance/i));
    expect(loadAttendance()).toHaveLength(1);
    expect(loadAttendance()[0]).toMatchObject({ worker_id: '1', status: 'present', ot_hours: 2 });
  });
});

describe('Staff record sheet', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders as a separate sheet with the full monthly salary', () => {
    renderPage();
    fireEvent.click(screen.getByText(/Record Sheet/i));

    const sheet = screen.getByTestId('staff-record-sheet');
    expect(within(sheet).getByText('Anita Rai')).toBeTruthy();
    expect(within(sheet).getByText(formatCurrency(55000))).toBeTruthy();
    expect(within(sheet).getByText(formatCurrency(48000))).toBeTruthy();
    expect(within(sheet).getByText(/never prorated/i)).toBeTruthy();
    // The worker record sheet is a separate table, still showing its worker.
    expect(screen.getByText('Rajesh Kumar')).toBeTruthy();
    expect(screen.getAllByText(/Monthly Salary/).length).toBeGreaterThanOrEqual(2);
  });

  it('prints the staff sheet as its own document, from the preview', async () => {
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});

    renderPage();
    fireEvent.click(screen.getByText(/Record Sheet/i));
    fireEvent.click(screen.getByTestId('staff-print'));

    // The preview IS the sheet that prints: same markup, same figures.
    const preview = screen.getByTestId('staff-print-sheet');
    expect(within(preview).getByText('Staff Attendance Record Sheet')).toBeTruthy();
    expect(within(preview).getByText('Anita Rai')).toBeTruthy();
    expect(within(preview).getByText(formatCurrency(55000))).toBeTruthy();
    expect(within(preview).getByText(/never prorates pay/i)).toBeTruthy();

    fireEvent.click(screen.getByTestId('attendance-print-run'));
    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));

    const root = document.getElementById('print-root');
    expect(root?.textContent).toContain('Staff Attendance Record Sheet');
    expect(root?.textContent).toContain('Anita Rai');
    expect(root?.textContent).toContain(formatCurrency(55000));

    window.dispatchEvent(new Event('afterprint'));
    printSpy.mockRestore();
  });

  it('shows the worker month sheet in the same preview, without a popup', () => {
    const openSpy = vi.spyOn(window, 'open');
    renderPage();
    fireEvent.click(screen.getByText(/Record Sheet/i));
    fireEvent.click(screen.getByTestId('worker-print'));

    const preview = screen.getByTestId('worker-print-sheet');
    expect(within(preview).getByText('Worker Attendance Record Sheet')).toBeTruthy();
    expect(within(preview).getByText('Rajesh Kumar')).toBeTruthy();
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('exports the staff sheet to Excel with fixed salaries', () => {
    renderPage();
    fireEvent.click(screen.getByText(/Record Sheet/i));

    const writeFile = (XLSX as any).writeFile as any;
    writeFile.mockClear();
    fireEvent.click(screen.getByTestId('staff-export'));

    expect(writeFile).toHaveBeenCalledTimes(1);
    const [workbook, filename] = writeFile.mock.calls[0];
    expect(filename).toMatch(/^Staff_Attendance_Record_.*\.xlsx$/);

    const sheet = workbook.Sheets['Staff Attendance'];
    expect(sheet).toBeTruthy();
    const rows = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1 });
    const header = rows[0].map((c) => String(c ?? ''));
    expect(header[0]).toBe('Staff');
    expect(header).toContain('Monthly Salary');
    const anita = rows.find((r) => r[0] === 'Anita Rai');
    expect(anita).toBeTruthy();
    expect(anita).toContain(formatCurrency(55000));
    expect(rows.some((r) => r[0] === 'Rajesh Kumar')).toBe(false);
  });
});
