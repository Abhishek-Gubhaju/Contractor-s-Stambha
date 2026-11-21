// @vitest-environment jsdom
// The Job Cost tab must show the project × cost-code roll-up, including the
// budget that comes from a BOQ item tagged with a cost code.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import JobCostView from './JobCostView';
import { saveEntry } from '../../services/booksService';
import { upsertCommitment } from '../../services/commitments';

const D = '2025-04-20';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(
    'contractoros_boq',
    JSON.stringify([
      {
        id: 's1',
        sectionCode: 'A',
        description: 'Substructure',
        amount: 0,
        isSection: true,
        children: [
          {
            id: '1',
            sectionCode: 'A',
            itemCode: 'A.01',
            description: 'Excavation',
            unit: 'm³',
            estimatedQuantity: 100,
            rate: 10,
            amount: 1000,
            actualMaterialCost: 0,
            actualLaborCost: 0,
            completedQuantity: 0,
            costCode: '0100',
          },
        ],
      },
    ])
  );
});

describe('Job Cost view', () => {
  it('shows accrued cost per cost code and its BOQ-derived budget', () => {
    saveEntry('supplier-bill', {
      date: D,
      supplier: 'Sample Steel',
      project: 'PRJ-001',
      cost_code: 'Materials',
      qty: 10,
      rate: 50,
      due_days: 30,
    });

    render(<JobCostView version={0} />);

    expect(screen.getByTestId('jobcost-code-PRJ-001-0100')).toBeTruthy();
    expect(screen.getByTestId('jobcost-code-accrued-PRJ-001-0100').textContent).toContain('500');
    expect(screen.getByTestId('jobcost-code-budget-PRJ-001-0100').textContent).toContain('1,000');
  });

  it('adds open commitments to the forecast', () => {
    saveEntry('supplier-bill', {
      date: D,
      supplier: 'Sample Steel',
      project: 'PRJ-001',
      cost_code: 'Materials',
      qty: 5,
      rate: 100,
      due_days: 30,
    });
    upsertCommitment({ ref: 'PO-9', vendor: 'ACC', project_id: 'PRJ-001', cost_code: 'Materials', amount: 2000, status: 'approved' });

    render(<JobCostView version={0} />);

    expect(screen.getByTestId('jobcost-committed-PRJ-001').textContent).toContain('2,000');
    expect(screen.getByTestId('jobcost-forecast-PRJ-001').textContent).toContain('2,500');
    expect(screen.getByTestId('jobcost-code-committed-PRJ-001-0100').textContent).toContain('2,000');
    expect(screen.getByTestId('jobcost-code-forecast-PRJ-001-0100').textContent).toContain('2,500');
  });

  it('separates jobs when the same cost code is used twice', () => {
    saveEntry('expense-paid', { date: D, category: 'Materials', project: 'PRJ-001', amount: 100, method: 'cash' });
    saveEntry('expense-paid', { date: D, category: 'Materials', project: 'PRJ-002', amount: 300, method: 'cash' });

    render(<JobCostView version={0} />);
    // The view opens scoped to the active job; widen it to see both.
    fireEvent.change(screen.getByTestId('jobcost-project-filter'), { target: { value: 'all' } });
    expect(screen.getByTestId('jobcost-code-accrued-PRJ-001-0100').textContent).toContain('100');
    expect(screen.getByTestId('jobcost-code-accrued-PRJ-002-0100').textContent).toContain('300');

    // Filtering to one job hides the other.
    fireEvent.change(screen.getByTestId('jobcost-project-filter'), { target: { value: 'PRJ-002' } });
    expect(screen.queryByTestId('jobcost-code-PRJ-001-0100')).toBeNull();
    expect(screen.getByTestId('jobcost-code-PRJ-002-0100')).toBeTruthy();
  });
});
