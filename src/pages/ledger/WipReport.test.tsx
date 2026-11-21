// @vitest-environment jsdom
// The WIP tab must show cost-to-date POC, earned revenue and the
// over/under-billing position for each project.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import WipReport from './WipReport';
import { saveEntry } from '../../services/booksService';
import { upsertProject } from '../../services/masterData';
import { setActiveProject } from '../../services/projectScope';
import { formatCurrency } from '../../utils';

beforeEach(() => {
  localStorage.clear();
  upsertProject({
    id: 'PRJ-001',
    name: 'Sample Commercial Complex',
    client: 'Gyan Constructions',
    status: 'active',
    startDate: '',
    endDate: '',
    contractValue: 100000,
    estimatedCost: 80000,
  });
});

function postCostAndBill(billed: number) {
  saveEntry('supplier-bill', {
    date: '2025-04-20',
    supplier: 'Sample Steel',
    project: 'PRJ-001',
    cost_code: 'Materials',
    qty: 400,
    rate: 100,
  });
  saveEntry('client-invoice', { date: '2025-04-21', client: 'C', project: 'PRJ-001', amount: billed, retention_pct: 0 });
}

describe('WIP view', () => {
  it('renders earned revenue and flags an over-billed job', () => {
    postCostAndBill(60000); // 60,000 billed against 50,000 earned

    render(<WipReport />);

    expect(screen.getByTestId('wip-report')).toBeTruthy();
    expect(screen.getByTestId('wip-row-PRJ-001')).toBeTruthy();
    expect(screen.getByTestId('wip-pct-PRJ-001').textContent).toContain('50.0%');
    expect(screen.getByTestId('wip-earned-PRJ-001').textContent).toContain(formatCurrency(50000));
    expect(screen.getByTestId('wip-overunder-PRJ-001').textContent).toContain('over-billed');
    expect(screen.getByTestId('wip-total-overunder')).toBeTruthy();
  });

  it('flags an under-billed job', () => {
    postCostAndBill(20000); // 20,000 billed against 50,000 earned

    render(<WipReport />);
    expect(screen.getByTestId('wip-overunder-PRJ-001').textContent).toContain('under-billed');
  });

  it('warns when a project has no estimated cost at completion', () => {
    upsertProject({
      id: 'PRJ-009',
      name: 'Annex',
      client: '',
      status: 'active',
      startDate: '',
      endDate: '',
      contractValue: 5000,
      estimatedCost: 0,
    });
    saveEntry('expense-paid', { date: '2025-04-20', category: 'Materials', project: 'PRJ-009', amount: 1000, method: 'cash' });

    // The schedule is scoped to the active job.
    setActiveProject('PRJ-009');
    render(<WipReport />);
    expect(screen.getByTestId('wip-warning')).toBeTruthy();
    expect(screen.getByTestId('wip-pct-PRJ-009').textContent).toContain('—');
  });
});
