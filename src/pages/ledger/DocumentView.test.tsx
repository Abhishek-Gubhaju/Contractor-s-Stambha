// @vitest-environment jsdom
// The voucher is the document a contractor hands over, so its print path is
// pinned: the sheet on screen is the sheet that prints, and while it is open
// File → Print (Cmd+P) targets it instead of the ledger behind it.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DocumentView } from './DocumentView';
import { entryById, saveEntry } from '../../services/booksService';
import { currentPrintTarget } from '../../services/print/printService';

const items = [
  {
    id: 'i1',
    line_no: 1,
    description: 'Cement',
    unit: 'bag',
    qty: 10,
    rate: 800,
    amount: 8000,
    cost_code: 'Materials',
    project_id: 'PRJ-001',
    boq_code: '',
  },
];

beforeEach(() => localStorage.clear());

describe('voucher print', () => {
  it('registers the voucher sheet and prints exactly that sheet', async () => {
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});
    const saved = saveEntry('supplier-bill', {
      date: '2026-11-12',
      supplier: 'Himalayan Hardware',
      ref: 'HH-9',
      project: 'PRJ-001',
      items,
      vat_rate: 13,
    });
    render(<DocumentView entry={entryById(saved.id) ?? null} onClose={() => {}} />);

    expect(currentPrintTarget()?.el).toBe(screen.getByTestId('doc-sheet'));

    fireEvent.click(screen.getByTestId('print-document'));
    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));

    const printed = document.getElementById('print-root');
    expect(printed?.textContent).toContain('Himalayan Hardware');
    expect(printed?.textContent).toContain('Cement');
    expect(printed?.querySelector('input')).toBeNull();
    // Only the Gantt opts into width fitting; a voucher keeps its own layout.
    expect(printed?.querySelector('[data-print-fit]')).toBeNull();
    // The PDF dialog offers the voucher number as the file name (slashes are
    // illegal in file names, so the title is sanitised).
    expect(document.title).toBe(`Voucher ${saved.id.replace(/\//g, '-')}`);

    window.dispatchEvent(new Event('afterprint'));
    printSpy.mockRestore();
  });
});
