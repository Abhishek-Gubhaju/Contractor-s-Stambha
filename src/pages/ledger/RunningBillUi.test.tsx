// @vitest-environment jsdom
// UI half of the running-bill work: the invoice form shows the cumulative
// figures, the advance held and a BOQ loader; the new document types have their
// own fieldsets.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import LedgerPage from '../Ledger';
import { saveEntry } from '../../services/booksService';
import { upsertParty } from '../../services/partyService';

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const todayAD = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

describe('running bill form', () => {
  it('shows billed-to-date, this bill and cumulative, plus the advance held', () => {
    saveEntry('client-advance', { date: todayAD(), client: 'Gyan Constructions', project: 'PRJ-001', amount: 25000, method: 'bank' });
    render(<LedgerPage />);
    fireEvent.click(screen.getByTestId('capture-button'));
    fireEvent.click(screen.getByTestId('type-client-invoice'));

    expect(screen.getByTestId('running-bill-summary')).toBeTruthy();
    expect(screen.getByTestId('load-boq-items')).toBeTruthy();
    // pick the client: the advance shown is that client's held balance
    fireEvent.change(screen.getByLabelText('Client'), { target: { value: 'Gyan Constructions' } });
    const advanceField = screen.getByLabelText(/Advance recovery/i);
    expect(String(advanceField.parentElement?.textContent)).toContain('25,000');
  });

  it('the advance field is not offered on a supplier bill', () => {
    render(<LedgerPage />);
    fireEvent.click(screen.getByTestId('capture-button'));
    fireEvent.click(screen.getByTestId('type-supplier-bill'));
    expect(screen.queryByLabelText(/Advance recovery/i)).toBeNull();
    expect(screen.getByTestId('items-editor')).toBeTruthy();
  });
});

describe('new document entry types', () => {
  it('client advance and opening balance have their own fields', () => {
    render(<LedgerPage />);
    fireEvent.click(screen.getByTestId('capture-button'));

    fireEvent.click(screen.getByTestId('type-client-advance'));
    expect(screen.getByLabelText('Advance amount')).toBeTruthy();
    expect(screen.getByLabelText('Received into')).toBeTruthy();

    fireEvent.click(screen.getByText('change type'));
    fireEvent.click(screen.getByTestId('type-opening-balance'));
    expect(screen.getByLabelText('Opening')).toBeTruthy();
    expect(screen.getByLabelText('Amount')).toBeTruthy();
  });

  it('offers parties from the master in the client picker', () => {
    upsertParty({ name: 'Gyan Constructions', type: 'client', pan: '601234567' });
    render(<LedgerPage />);
    fireEvent.click(screen.getByTestId('capture-button'));
    fireEvent.click(screen.getByTestId('type-client-advance'));
    const options = [...document.querySelectorAll('#hop-clients option')].map((o) => (o as HTMLOptionElement).value);
    expect(options).toContain('Gyan Constructions');
  });
});
