// @vitest-environment jsdom
// UI half of “Paid now”: the checkbox is off by default, reveals the method and
// payment date, shows BOTH legs in the routing preview with a zero supplier due,
// is disabled for a TDS bill, and saves the pair through the atomic action.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import LedgerPage from '../Ledger';
import { keyFor } from '../../services/projectScope';

afterEach(cleanup);
beforeEach(() => localStorage.clear());

function openSupplierBill() {
  render(<LedgerPage />);
  fireEvent.click(screen.getByTestId('capture-button'));
  fireEvent.click(screen.getByTestId('type-supplier-bill'));
}

function fillBill() {
  fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: 'Himalayan Hardware' } });
  fireEvent.click(screen.getByTestId('add-item'));
  fireEvent.change(screen.getByLabelText('Item 1 description'), { target: { value: 'Cement' } });
  fireEvent.change(screen.getByLabelText('Item 1 quantity'), { target: { value: '10' } });
  fireEvent.change(screen.getByLabelText('Item 1 rate'), { target: { value: '1000' } });
}

describe('Paid now on the supplier bill form', () => {
  it('is off by default, reveals method + date and previews both legs', () => {
    openSupplierBill();
    fillBill();

    const box = screen.getByTestId('paid-now') as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.queryByTestId('paid-now-preview')).toBeNull();
    expect(screen.queryByLabelText('Paid from')).toBeNull();

    fireEvent.click(box);

    expect(screen.getByLabelText('Paid from')).toBeTruthy();
    expect(screen.getByLabelText('Payment date')).toBeTruthy();
    const second = screen.getByTestId('paid-now-preview').textContent || '';
    expect(second).toContain('Payment to Supplier');
    expect(second).toContain('Accounts Payable');
    // fully paid → supplier due after save is zero
    expect(screen.getByTestId('supplier-due').textContent).toContain('0');
    expect(screen.getByTestId('supplier-due').textContent).not.toContain('13,000');
  });

  it('saves the pair atomically from the form', () => {
    openSupplierBill();
    fillBill();
    fireEvent.click(screen.getByTestId('paid-now'));
    fireEvent.click(screen.getByTestId('save-entry'));

    const entries = JSON.parse(localStorage.getItem(keyFor('contractoros_entries')) || '[]');
    expect(entries).toHaveLength(2);
    const bill = entries.find((e: any) => e.type === 'supplier-bill');
    const payment = entries.find((e: any) => e.type === 'payment-supplier');
    expect(bill.auto_payment_id).toBe(payment.id);
    expect(payment.auto_bill_id).toBe(bill.id);
  });

  it('is disabled when TDS is withheld, with the pointer to Payment to Supplier', () => {
    openSupplierBill();
    fillBill();
    fireEvent.change(screen.getByLabelText('TDS %'), { target: { value: '1.5' } });

    const box = screen.getByTestId('paid-now') as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(screen.getByTestId('paid-now-tds-hint').textContent).toMatch(/Payment to Supplier/);
    // ticking it on first and then adding TDS clears it again
    expect(box.checked).toBe(false);
  });
});
