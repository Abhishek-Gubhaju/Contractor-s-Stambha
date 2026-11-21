import React, { useState, useEffect } from 'react';
import { FileText, Users, ClipboardList, DollarSign, Clock, TrendingUp, TrendingDown, CheckCircle, XCircle, Coffee, AlertTriangle } from 'lucide-react';
import { formatCurrency, getCurrentMonthInTimezone, STANDARD_WORK_HOURS } from '../utils';
import { getTodayBS, formatBS } from '../utils/nepaliDate';
import { dsrLines, cumulativeMap, migrateReports } from '../services/dsrService';
import { amountOf } from '../services/boq/boqModel';
import { STAFF_LEAVE_LIMIT, staffOverLeaveLimit } from '../services/staffAttendanceService';

export default function Dashboard({ poData, timezone, boqData, laborData, dsrData, billingEntries = [], userName }: { poData: any[]; timezone: string; boqData: any[]; laborData: any[]; dsrData: any[]; billingEntries?: any[]; userName?: string }) {
  // Greet whoever is signed in. With no name the greeting stays name-free —
  // an empty first run must never invent somebody else's name.
  const firstName = String(userName || '').trim().split(/\s+/)[0] || '';
  const pendingPOs = poData.filter((p: any) => p.status === 'pending');

  // Real-time calculations
  const totalBOQItems = boqData.reduce((sum: number, section: any) => sum + (section.children || []).length, 0);
  const totalBOQAmount = boqData.reduce((sum: number, section: any) =>
    sum + (section.children || []).reduce((s: number, item: any) => s + amountOf(item), 0), 0);

  const presentWorkers = laborData.filter((l: any) => l.status === 'present').length;
  const absentWorkers = laborData.filter((l: any) => l.status === 'absent').length;
  const leaveWorkers = laborData.filter((l: any) => l.status === 'leave').length;
  const dailyLaborCost = laborData
    .filter((l: any) => l.status === 'present')
    .reduce((sum: number, l: any) => sum + (l.hoursWorked / STANDARD_WORK_HOURS) * l.dailyWage + l.overtimeHours * (l.dailyWage / STANDARD_WORK_HOURS) * 1.5, 0);

  // Staff who have gone past the monthly leave allowance (staff pay is a fixed
  // monthly salary, so this is a staffing alert — not a payroll adjustment).
  const staffLeaveAlerts = staffOverLeaveLimit(getCurrentMonthInTimezone(timezone));

  const totalDSR = dsrData.length;
  const submittedDSR = dsrData.filter((d: any) => d.isSubmitted).length;
  const draftDSR = totalDSR - submittedDSR;

  // Current month is the APP timezone's month (YYYY-MM), not the machine's —
  // DSR dates are stored as A.D. calendar days, so the prefix comparison is
  // exact and avoids local-midnight boundary drift.
  const ymDash = getCurrentMonthInTimezone(timezone).replace('-', '/');
  // One flattening rule for every report shape (a day can report many items).
  const monthLines = dsrLines(dsrData).filter((l) => l.date.slice(0, 7) === ymDash.replace('/', '-'));
  const doneByCode = cumulativeMap(dsrData);
  const currentMonthBilled = boqData.reduce((sum: number, section: any) =>
    sum + (section.children || []).reduce((s: number, item: any) => {
      const code = String(item.itemCode || '').trim().toLowerCase();
      const monthWork = monthLines
        .filter((l) => l.boqCode.trim().toLowerCase() === code)
        .reduce((ds, l) => ds + l.quantity, 0);
      return s + (monthWork * (Number(item.rate) || 0));
    }, 0), 0);

  // Prefer actual billing entries for the current month; fall back to DSR-derived work value.
  // Billing stores the month at data.monthlyYearMonth and the amount at
  // netAmount / data.NetAmount (see Billing.handleSaveBill).
  const billedFromEntries = billingEntries.reduce((s: number, b: any) => {
    const rowYm = b?.data?.monthlyYearMonth || b?.monthlyYearMonth || '';
    if (rowYm !== ymDash) return s;
    return s + (Number(b?.data?.NetAmount ?? b?.netAmount) || 0);
  }, 0);
  const currentMonthBilledTotal = billedFromEntries > 0 ? billedFromEntries : currentMonthBilled;

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-gray-500 text-sm mt-1">Welcome back{firstName ? `, ${firstName}` : ''}. Here's your project overview.</p>
          <p className="text-xs text-indigo-600 font-medium mt-0.5">B.S. Today: {formatBS(getTodayBS())}</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="flex items-center gap-3">
            <Clock className="w-6 h-6 text-gray-400" />
            <div>
              <p className="text-xs text-gray-500">Current Time</p>
              <p className="text-lg font-semibold text-gray-900"><LiveClock timezone={timezone} /></p>
            </div>
          </div>
        </div>
      </div>

      {staffLeaveAlerts.length > 0 && (
        <div className="rounded-xl border border-gray-200 border-l-2 border-l-red-600 bg-white p-4" data-testid="staff-leave-alert" role="alert">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-red-50 flex items-center justify-center flex-shrink-0">
              <AlertTriangle className="w-5 h-5 text-red-600" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-red-800">Staff leave over the {STAFF_LEAVE_LIMIT}-day limit</p>
              <p className="text-xs text-red-700 mt-0.5">
                {staffLeaveAlerts.length === 1 ? '1 staff member has' : `${staffLeaveAlerts.length} staff members have`} used more than {STAFF_LEAVE_LIMIT} leave days this month. Their salary is unchanged.
              </p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {staffLeaveAlerts.slice(0, 8).map((s) => (
                  <li key={s.staff_id} className="text-xs bg-white border border-gray-200 rounded-full px-2.5 py-1 text-gray-700">
                    <span className="font-medium">{s.name}</span>{s.code ? ` · ${s.code}` : ''} · {s.leave} days
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard
          title="BOQ Items"
          value={totalBOQItems.toString()}
          subtitle={formatCurrency(totalBOQAmount) + " total value"}
          icon={<FileText className="w-5 h-5" />}
          iconBg="bg-gray-100 text-gray-600"
          trend={`${boqData.length} sections`}
          trendUp={true}
        />
        <KPICard
          title="Workers Present"
          value={presentWorkers.toString()}
          subtitle={`${absentWorkers} absent, ${leaveWorkers} on leave`}
          icon={<Users className="w-5 h-5" />}
          iconBg="bg-gray-100 text-gray-600"
          trend={formatCurrency(dailyLaborCost) + " daily cost"}
          trendUp={true}
        />
        <KPICard
          title="DSR Reports"
          value={totalDSR.toString()}
          subtitle={`${submittedDSR} submitted, ${draftDSR} drafts`}
          icon={<ClipboardList className="w-5 h-5" />}
          iconBg="bg-gray-100 text-gray-600"
          trend={submittedDSR > 0 ? `${Math.round((submittedDSR/totalDSR)*100)}% submitted` : "No submissions"}
          trendUp={submittedDSR > 0}
        />
        <KPICard
          title="Month Billing"
          value={formatCurrency(currentMonthBilledTotal)}
          subtitle="Current month progress"
          icon={<DollarSign className="w-5 h-5" />}
          iconBg="bg-gray-100 text-gray-600"
          trend={pendingPOs.length > 0 ? `${pendingPOs.length} POs pending` : "All POs cleared"}
          trendUp={pendingPOs.length === 0}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="font-semibold text-gray-900 mb-4">Recent Purchase Orders</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-100">
                <th className="pb-2 font-medium">PO Number</th>
                <th className="pb-2 font-medium">Vendor</th>
                <th className="pb-2 font-medium">Amount</th>
                <th className="pb-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {poData.slice(0, 5).map((po: any) => (
                <tr key={po.id} className="hover:bg-gray-50">
                  <td className="py-2.5 font-medium text-gray-900">{po.poNumber}</td>
                  <td className="py-2.5 text-gray-600">{po.vendor}</td>
                  <td className="py-2.5 text-gray-900 font-medium">{formatCurrency(po.totalAmount)}</td>
                  <td className="py-2.5"><StatusBadge status={po.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="font-semibold text-gray-900 mb-4">Recent DSR Reports</h3>
          {dsrData.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-8">No DSR reports yet</p>
          ) : (
            <div className="space-y-3">
              {migrateReports(dsrData).slice(0, 5).map((dsr) => (
                <div key={dsr.id} className="flex items-start gap-3 p-3 rounded-lg border border-gray-100 hover:border-gray-300 hover:bg-gray-50 transition-colors">
                  <div className="flex-shrink-0">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center ${dsr.status !== 'draft' ? 'bg-green-100' : 'bg-amber-100'}`}>
                      {dsr.status !== 'draft' ? <CheckCircle className="w-4 h-4 text-green-600" /> : <Clock className="w-4 h-4 text-amber-600" />}
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-mono bg-gray-100 text-gray-700 px-2 py-0.5 rounded">{dsr.reportNo || dsr.boqCode || 'DSR'}</span>
                      <span className="text-xs text-gray-500">{new Date(dsr.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                    </div>
                    <p className="text-sm text-gray-700 truncate">{dsr.items.map((i) => i.description || i.boqCode).filter(Boolean).join(' · ') || 'No work item'}</p>
                    {dsr.items.length > 0 && (
                      <p className="text-xs text-gray-500 mt-1">
                        {Math.round(dsr.items.reduce((s, i) => s + (Number(i.quantity) || 0), 0) * 100) / 100} total · {dsr.labour.reduce((s, l) => s + (Number(l.count) || 0), 0)} men
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="font-semibold text-gray-900 mb-4">Worker Attendance Summary</h3>
          <div className="space-y-4">
            <div className="flex items-center justify-between p-3 border border-gray-200 rounded-lg">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-gray-900 flex items-center justify-center text-white font-semibold">
                  {presentWorkers}
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-900">Present Today</p>
                  <p className="text-xs text-gray-500">{laborData.length} total workers</p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-lg font-semibold text-gray-900">{formatCurrency(dailyLaborCost)}</p>
                <p className="text-xs text-gray-500">Daily cost</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 border border-gray-200 rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <XCircle className="w-4 h-4 text-red-600" />
                  <span className="text-xs text-gray-600">Absent</span>
                </div>
                <p className="text-2xl font-semibold text-gray-900">{absentWorkers}</p>
              </div>
              <div className="p-3 border border-gray-200 rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <Coffee className="w-4 h-4 text-amber-600" />
                  <span className="text-xs text-gray-600">On Leave</span>
                </div>
                <p className="text-2xl font-semibold text-gray-900">{leaveWorkers}</p>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="font-semibold text-gray-900 mb-4">BOQ Progress Overview</h3>
          <div className="space-y-3">
            {boqData.map((section: any) => {
              const sectionTotal = (section.children || []).reduce((sum: number, item: any) => sum + amountOf(item), 0);
              const sectionCompleted = (section.children || []).reduce((sum: number, item: any) => {
                const actualWork = doneByCode.get(String(item.itemCode || '').trim().toLowerCase()) || 0;
                const progressPercent = item.estimatedQuantity > 0
                  ? Math.min((actualWork / item.estimatedQuantity) * 100, 100)
                  : 0;
                return sum + (progressPercent / 100) * amountOf(item);
              }, 0);
              const progress = sectionTotal > 0 ? (sectionCompleted / sectionTotal) * 100 : 0;

              return (
                <div key={section.id} className="p-3 border border-gray-100 rounded-lg">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono bg-slate-100 text-slate-700 px-2 py-0.5 rounded">{section.sectionCode}</span>
                      <span className="text-sm font-medium text-gray-900">{section.description}</span>
                    </div>
                    <span className="text-sm font-bold text-gray-700">{progress.toFixed(1)}%</span>
                  </div>
                  <div className="w-full bg-gray-100 rounded-full h-2">
                    <div
                      className={`h-2 rounded-full transition-all ${progress < 50 ? 'bg-red-600' : 'bg-gray-900'}`}
                      style={{ width: `${Math.min(progress, 100)}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between mt-2 text-xs text-gray-500">
                    <span>{(section.children || []).length} items</span>
                    <span>{formatCurrency(sectionCompleted)} / {formatCurrency(sectionTotal)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// Ticking clock isolated in its own component so the 1s interval re-renders
// only this line — not every table and KPI on the dashboard.
function LiveClock({ timezone }: { timezone: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  try {
    return (
      <>
        {now.toLocaleString('en-US', {
          timeZone: timezone,
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: true,
        })}
      </>
    );
  } catch {
    return <>{now.toLocaleString()}</>;
  }
}

function KPICard({ title, value, subtitle, icon, iconBg, trend, trendUp }: { title: string; value: string; subtitle: string; icon: React.ReactNode; iconBg: string; trend: string; trendUp: boolean }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-gray-500 font-medium">{title}</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
          <p className="text-xs text-gray-400 mt-1">{subtitle}</p>
        </div>
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${iconBg}`}>{icon}</div>
      </div>
      <div className="mt-3 flex items-center gap-1">
        {trendUp ? <TrendingUp className="w-3.5 h-3.5 text-green-500" /> : <TrendingDown className="w-3.5 h-3.5 text-red-500" />}
        <span className={`text-xs font-medium ${trendUp ? 'text-green-600' : 'text-red-600'}`}>{trend}</span>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: 'bg-amber-50 text-amber-700',
    approved: 'bg-gray-100 text-gray-700',
    delivered: 'bg-green-50 text-green-700',
    manual: 'bg-gray-100 text-gray-600'
  };
  return <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${styles[status] || 'bg-gray-100 text-gray-700'}`}>{status.charAt(0).toUpperCase() + status.slice(1)}</span>;
}
