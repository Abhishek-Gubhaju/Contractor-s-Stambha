// @vitest-environment jsdom
// The Worker Advance form's picker: names, not ids; the staff number appears
// only for two people who share a name.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import LedgerPage from '../Ledger';
import { scopedKey } from '../../services/projectScope';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

function seedStaff(rows: any[]) {
  localStorage.setItem(scopedKey('contractoros_staff', 'PRJ-001'), JSON.stringify(rows));
}

function openWorkerAdvance() {
  render(<LedgerPage />);
  fireEvent.click(screen.getByTestId('capture-button'));
  fireEvent.click(screen.getByTestId('type-worker-advance'));
}

describe('worker advance picker', () => {
  it('lists staff by name instead of their raw id', () => {
    seedStaff([{ id: 'staff-1794962406446', code: 'STF-001', firstName: 'Asha', lastName: 'Rai', status: 'active' }]);
    openWorkerAdvance();

    expect(screen.getByRole('option', { name: 'Asha Rai' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /staff:staff-/ })).toBeNull();
  });

  it('adds the staff number when two staff share a name', () => {
    seedStaff([
      { id: 'staff-1', code: 'STF-001', firstName: 'Asha', lastName: 'Rai', status: 'active' },
      { id: 'staff-2', code: 'STF-002', firstName: 'Asha', lastName: 'Rai', status: 'active' },
    ]);
    openWorkerAdvance();

    expect(screen.getByRole('option', { name: 'Asha Rai (STF-001)' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Asha Rai (STF-002)' })).toBeTruthy();
  });
});
