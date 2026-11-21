// @vitest-environment jsdom
// The shared transaction detail: complete read-only facts, documents with
// preview/download, graceful legacy rendering, and the statement "i" button.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TransactionDetail } from './TransactionDetail';
import Statements from './Statements';
import { saveEntry } from '../../services/booksService';

const D = '2025-04-20'; // Baisakh 2082
const P = { year: 2082, month: 1 };

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const expense = () =>
  saveEntry('expense-paid', { date: D, category: 'Transport', amount: 1200, method: 'cash', ref: 'TR-1', note: 'Site delivery' });

describe('transaction detail', () => {
  it('shows every stored field and the attached document', () => {
    const entry = saveEntry(
      'expense-paid',
      { date: D, category: 'Transport', amount: 1200, method: 'cash', ref: 'TR-1', note: 'Site delivery' },
      { attachment_file: { fileName: 'receipt.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA', sizeBytes: 3 } }
    );
    render(<TransactionDetail entryId={entry.id} onClose={() => {}} />);

    expect(screen.getByTestId('transaction-detail')).toBeTruthy();
    expect(screen.getAllByText(entry.id).length).toBeGreaterThan(0);
    // Each also appears on the general-ledger line, so match any occurrence.
    expect(screen.getAllByText('Transport').length).toBeGreaterThan(0);
    // No project was chosen on this entry, so it books to overhead.
    expect(screen.getAllByText('overhead').length).toBeGreaterThan(0);
    expect(screen.getAllByText('TR-1').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Site delivery').length).toBeGreaterThan(0);
    expect(screen.getByText(/A\.D\. 2025-04-20/)).toBeTruthy();
    expect(screen.queryByTestId('detail-no-documents')).toBeNull();

    expect(screen.getByText('receipt.png')).toBeTruthy();
    const download = screen.getByText('Download').closest('a')!;
    expect(download.getAttribute('download')).toBe('receipt.png');
    expect(String(download.getAttribute('href'))).toContain('data:image/png');

    fireEvent.click(screen.getByTestId('detail-document-view'));
    expect(screen.getByTestId('detail-preview')).toBeTruthy();
    expect(screen.getByAltText('receipt.png')).toBeTruthy();
  });

  it('shows the explicit empty state with no documents and no links', () => {
    const entry = expense();
    render(<TransactionDetail entryId={entry.id} onClose={() => {}} />);
    expect(screen.getByTestId('detail-no-documents').textContent).toMatch(/No documents attached/i);
    expect(screen.getByTestId('detail-no-links')).toBeTruthy();
  });

  it('renders a legacy entry that is missing optional fields without crashing', () => {
    localStorage.setItem(
      'contractoros_entries',
      JSON.stringify([
        { id: 'OLD-1', type: 'receipt', ad_date: '2020-01-01', ref: '', note: '', attachment: '', source: 'manual', created_at: '', edited_history: [] },
      ])
    );
    render(<TransactionDetail entryId="OLD-1" onClose={() => {}} />);
    expect(screen.getByTestId('transaction-detail')).toBeTruthy();
    expect(screen.getByText(/B\.S\. unavailable/)).toBeTruthy();
    expect(screen.getByTestId('detail-no-documents')).toBeTruthy();
  });

  it('says so when the entry cannot be found', () => {
    render(<TransactionDetail entryId="MISSING-9" onClose={() => {}} />);
    expect(screen.getByTestId('detail-not-found')).toBeTruthy();
  });
});

describe('statement info button', () => {
  it('opens the detail from a cash row and closes on Escape', () => {
    const entry = expense();
    render(<Statements period={P} version={0} />);

    const closingBefore = screen.getByTestId('statement-closing-cash').textContent;
    fireEvent.click(screen.getByTestId('info-cash'));

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getAllByText(new RegExp(entry.id)).length).toBeGreaterThan(0);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    // The statement itself is untouched.
    expect(screen.getByTestId('statement-closing-cash').textContent).toBe(closingBefore);
  });
});
