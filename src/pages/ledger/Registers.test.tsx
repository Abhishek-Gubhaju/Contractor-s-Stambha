// @vitest-environment jsdom
// The registers must show what the books posted: party, PAN, taxable value,
// VAT, total — with reversed documents struck through and out of the totals.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Registers from './Registers';
import { saveEntry } from '../../services/booksService';
import { upsertParty } from '../../services/partyService';

const D = '2026-11-12';
const PERIOD = { year: 2083, month: 7 };

const items = (amount: number) => [
  { id: 'i1', line_no: 1, description: 'Cement', unit: 'bag', qty: amount / 800, rate: 800, amount, cost_code: 'Materials', project_id: 'PRJ-001', boq_code: '' },
];

beforeEach(() => localStorage.clear());

describe('purchase / sales registers', () => {
  it('lists a purchase bill with the party PAN and the VAT split', () => {
    upsertParty({ name: 'Himalayan Hardware', type: 'supplier', pan: '601234567' });
    saveEntry('supplier-bill', { date: D, supplier: 'Himalayan Hardware', ref: 'HH-9', project: 'PRJ-001', items: items(80000), vat_rate: 13 });

    render(<Registers period={PERIOD} kind="purchase" setKind={() => {}} />);
    const sheet = screen.getByTestId('register-sheet');
    expect(sheet.textContent).toContain('Himalayan Hardware');
    expect(sheet.textContent).toContain('601234567');
    expect(sheet.textContent).toContain('NRS 80,000');
    expect(sheet.textContent).toContain('NRS 10,400');
    expect(sheet.textContent).toContain('NRS 90,400');
  });

  it('switches to the sales register', () => {
    saveEntry('client-invoice', { date: D, client: 'Gyan Constructions', project: 'PRJ-001', items: items(40000), vat_rate: 0 });
    const setKind = (k: 'purchase' | 'sales') => {
      render(<Registers period={PERIOD} kind={k} setKind={() => {}} />);
    };
    render(<Registers period={PERIOD} kind="purchase" setKind={() => {}} />);
    expect(screen.getByTestId('register-sheet').textContent).not.toContain('Gyan Constructions');

    setKind('sales');
    const sales = screen.getAllByTestId('register-sheet').pop()!;
    expect(sales.textContent).toContain('Gyan Constructions');
    expect(sales.textContent).toContain('NRS 40,000');
  });

  it('has a print and a CSV control', () => {
    render(<Registers period={PERIOD} kind="purchase" setKind={() => {}} />);
    expect(screen.getByTestId('register-print')).toBeTruthy();
    expect(screen.getByTestId('register-csv')).toBeTruthy();
    fireEvent.click(screen.getByTestId('register-purchase'));
  });

  it('prints the register sheet itself, not the page around it', async () => {
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});
    upsertParty({ name: 'Himalayan Hardware', type: 'supplier', pan: '601234567' });
    saveEntry('supplier-bill', { date: D, supplier: 'Himalayan Hardware', ref: 'HH-9', project: 'PRJ-001', items: items(80000), vat_rate: 13 });

    render(<Registers period={PERIOD} kind="purchase" setKind={() => {}} />);
    fireEvent.click(screen.getByTestId('register-print'));

    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
    const printed = document.getElementById('print-root');
    expect(printed?.textContent).toContain('Purchase Register');
    expect(printed?.textContent).toContain('Himalayan Hardware');
    expect(printed?.textContent).toContain('NRS 90,400');

    window.dispatchEvent(new Event('afterprint'));
    printSpy.mockRestore();
  });
});
