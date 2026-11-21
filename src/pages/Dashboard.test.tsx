// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Dashboard from './Dashboard';
import { getCurrentMonthInTimezone } from '../utils';
import { formatCurrency } from '../utils';

const TZ = 'Asia/Kathmandu';

function renderDashboard(billingEntries: any[]) {
  return render(
    <Dashboard
      poData={[]}
      timezone={TZ}
      boqData={[]}
      laborData={[]}
      dsrData={[]}
      billingEntries={billingEntries}
    />
  );
}

describe('Dashboard month billing', () => {
  it("counts entries filed under the app timezone's month", () => {
    const ym = getCurrentMonthInTimezone(TZ).replace('-', '/');
    renderDashboard([
      { billId: 'AUTH-1', netAmount: 12345, data: { monthlyYearMonth: ym, NetAmount: 12345 } },
    ]);
    expect(screen.getByText(formatCurrency(12345))).toBeTruthy();
  });

  it('ignores entries from other months', () => {
    const [y, m] = getCurrentMonthInTimezone(TZ).split('-').map(Number);
    const otherMonth = `${m === 1 ? y - 1 : y}/${String(m === 1 ? 12 : m - 1).padStart(2, '0')}`;
    renderDashboard([
      { billId: 'AUTH-2', netAmount: 9999, data: { monthlyYearMonth: otherMonth, NetAmount: 9999 } },
    ]);
    expect(screen.queryByText(formatCurrency(9999))).toBeNull();
  });
});
