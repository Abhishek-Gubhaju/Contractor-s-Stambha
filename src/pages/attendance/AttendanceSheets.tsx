// ============================================================================
// AttendanceSheets — the month record sheets as real, printable DOM.
//
// These used to be HTML strings written into a `window.open` popup. A popup is
// blocked in the desktop app and is a different document from the one on
// screen, so the printout could not match any preview. They are React now, so
// the same markup is the preview and the paper.
// ============================================================================
import { loadCompany } from '../../services/companyService';
import { STAFF_LEAVE_LIMIT } from '../../services/staffAttendanceService';
import { formatCurrency, STANDARD_WORK_HOURS } from '../../utils';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const th = 'border border-gray-300 px-1 py-1 text-center font-semibold';
const td = 'border border-gray-300 px-1 py-1 text-center';

function monthLabelOf(month: string): string {
  return new Date(`${month}-01`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function daysOf(month: string) {
  const [year, m] = month.split('-').map(Number);
  const count = new Date(year, m, 0).getDate();
  return Array.from({ length: count }, (_, i) => {
    const day = i + 1;
    const dow = new Date(year, m - 1, day).getDay();
    return {
      day,
      dateStr: `${month}-${String(day).padStart(2, '0')}`,
      weekend: dow === 0 || dow === 6,
      weekday: DAY_NAMES[dow],
    };
  });
}

function SheetHead({ title, month, project }: { title: string; month: string; project: string }) {
  const company = loadCompany();
  return (
    <div className="border-b-2 border-gray-800 pb-2 mb-3 flex items-start justify-between">
      <div>
        <p className="text-base font-bold">{company.name || 'Your company name'}</p>
        {company.address && <p className="text-xs text-gray-600">{company.address}</p>}
        <p className="text-xs text-gray-600">
          {company.pan && <>PAN: {company.pan}</>}
          {company.pan && company.vatNo && ' · '}
          {company.vatNo && <>VAT No: {company.vatNo}</>}
        </p>
      </div>
      <div className="text-right">
        <p className="font-bold uppercase">{title}</p>
        <p className="text-xs">Month: {monthLabelOf(month)} (A.D.)</p>
        <p className="text-xs">Job: {project}</p>
      </div>
    </div>
  );
}

function Legend() {
  return (
    <p className="mt-2 text-[10px] text-gray-600">
      P = Present · A = Absent · L = Leave · NWD = Non-Working Day
    </p>
  );
}

export interface StaffSheetRow {
  staff_id: string;
  name: string;
  code: string;
  present: number;
  absent: number;
  leave: number;
  overLeaveLimit: boolean;
  salary: number;
}

export function StaffAttendanceSheet({
  month,
  project,
  rows,
  statusOn,
}: {
  month: string;
  project: string;
  rows: StaffSheetRow[];
  statusOn: (dateStr: string, staffId: string) => string;
}) {
  const days = daysOf(month);
  return (
    <div className="bg-white text-gray-900 p-4 text-[10px]" data-testid="staff-print-sheet">
      <SheetHead title="Staff Attendance Record Sheet" month={month} project={project} />
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-gray-100">
            <th className={`${th} text-left`}>Staff</th>
            <th className={th}>Code</th>
            {days.map((d) => (
              <th key={d.day} className={`${th} ${d.weekend ? 'bg-gray-50' : ''}`}>
                <span className="block">{d.day}</span>
                <span className="block text-[8px] text-gray-500">{d.weekday}</span>
              </th>
            ))}
            <th className={th}>P</th>
            <th className={th}>A</th>
            <th className={th}>L</th>
            <th className={th}>Monthly Salary</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.staff_id}>
              <td className={`${td} text-left whitespace-nowrap`}>{s.name}</td>
              <td className={td}>{s.code || '—'}</td>
              {days.map((d) => {
                const status = statusOn(d.dateStr, s.staff_id);
                const label = status === 'present' ? 'P' : status === 'absent' ? 'A' : status === 'leave' ? 'L' : '';
                const tone =
                  status === 'present'
                    ? 'bg-green-50 text-green-700'
                    : status === 'absent'
                      ? 'bg-red-50 text-red-700'
                      : status === 'leave'
                        ? 'bg-gray-900 text-white'
                        : '';
                return (
                  <td key={d.day} className={`${td} ${d.weekend && !status ? 'bg-gray-50' : ''}`}>
                    {label && <span className={`inline-block w-4 h-4 leading-4 rounded-sm font-bold ${tone}`}>{label}</span>}
                  </td>
                );
              })}
              <td className={`${td} font-semibold`}>{s.present}</td>
              <td className={`${td} font-semibold`}>{s.absent}</td>
              <td className={`${td} font-semibold`}>
                {s.leave}
                {s.overLeaveLimit ? ' !' : ''}
              </td>
              <td className={`${td} whitespace-nowrap`}>{formatCurrency(s.salary)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[10px] text-gray-600">
        Salary is the fixed monthly salary — staff attendance never prorates pay. Leave allowance: {STAFF_LEAVE_LIMIT} days
        per month.
      </p>
      <Legend />
    </div>
  );
}

export interface WorkerSheetRow {
  id: string;
  name: string;
  code: string;
  dailyWage: number;
}

export function WorkerAttendanceSheet({
  month,
  project,
  workers,
  statusOn,
  nonWorkingDays,
}: {
  month: string;
  project: string;
  workers: WorkerSheetRow[];
  statusOn: (dateStr: string, workerId: string) => { status: string; overtimeHours: number } | null;
  nonWorkingDays: Set<number>;
}) {
  const days = daysOf(month);
  return (
    <div className="bg-white text-gray-900 p-4 text-[10px]" data-testid="worker-print-sheet">
      <SheetHead title="Worker Attendance Record Sheet" month={month} project={project} />
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-gray-100">
            <th className={`${th} text-left`}>Worker</th>
            <th className={th}>Code</th>
            {days.map((d) => (
              <th key={d.day} className={`${th} ${d.weekend ? 'bg-gray-50' : ''}`}>
                <span className="block">{d.day}</span>
                <span className="block text-[8px] text-gray-500">{d.weekday}</span>
              </th>
            ))}
            <th className={th}>P</th>
            <th className={th}>A</th>
            <th className={th}>L</th>
            <th className={th}>Wages</th>
          </tr>
        </thead>
        <tbody>
          {workers.map((w) => {
            let present = 0;
            let absent = 0;
            let leave = 0;
            let overtime = 0;
            return (
              <tr key={w.id}>
                <td className={`${td} text-left whitespace-nowrap`}>{w.name}</td>
                <td className={td}>{w.code}</td>
                {days.map((d) => {
                  if (nonWorkingDays.has(d.day)) {
                    return (
                      <td key={d.day} className={td}>
                        <span className="inline-block px-0.5 text-[9px] font-bold text-gray-600">NWD</span>
                      </td>
                    );
                  }
                  const mark = statusOn(d.dateStr, w.id);
                  if (mark?.status === 'present') {
                    present += 1;
                    overtime += mark.overtimeHours;
                  }
                  if (mark?.status === 'absent') absent += 1;
                  if (mark?.status === 'leave') leave += 1;
                  const label = mark?.status === 'present' ? 'P' : mark?.status === 'absent' ? 'A' : mark?.status === 'leave' ? 'L' : '';
                  const tone =
                    mark?.status === 'present'
                      ? 'bg-green-50 text-green-700'
                      : mark?.status === 'absent'
                        ? 'bg-red-50 text-red-700'
                        : mark?.status === 'leave'
                          ? 'bg-gray-900 text-white'
                          : '';
                  return (
                    <td key={d.day} className={`${td} ${d.weekend && !label ? 'bg-gray-50' : ''}`}>
                      {label && <span className={`inline-block w-4 h-4 leading-4 rounded-sm font-bold ${tone}`}>{label}</span>}
                    </td>
                  );
                })}
                <td className={`${td} font-semibold`}>{present}</td>
                <td className={`${td} font-semibold`}>{absent}</td>
                <td className={`${td} font-semibold`}>{leave}</td>
                <td className={`${td} whitespace-nowrap`}>
                  {formatCurrency(present * w.dailyWage + overtime * (w.dailyWage / STANDARD_WORK_HOURS) * 1.5)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Legend />
    </div>
  );
}
