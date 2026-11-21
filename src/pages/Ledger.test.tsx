// @vitest-environment jsdom
// Acceptance checks on the rebuilt Ledger page:
//   71 (UI half) — legacy tabs/form gone, new five-view shell present
//   72 — every hopper type shows ONLY its fields; preview == saved lines
//   74 — auto-entries read-only in Feed with jump links to their source
//   76 — locked period rejects save with a message; unlock logs the reason
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, describe, vi } from 'vitest';
import LedgerPage from './Ledger';
import { currentPrintTarget } from '../services/print/printService';
import {
  allEntries,
  linesOf,
  getAudit,
  billingInvoiceEntry,
  payrollAccrualEntry,
} from '../services/booksService';

afterEach(() => {
  // A print test leaves its cloned sheet in #print-root until the dialog
  // closes; close it so the next test sees one page, not two.
  window.dispatchEvent(new Event('afterprint'));
  cleanup();
});
beforeEach(() => localStorage.clear());

const todayAD = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

function page(onNavigate?: (p: string) => void) {
  return <LedgerPage onNavigate={onNavigate} />;
}

describe('71 (UI). legacy Ledger deleted; new five-view shell present', () => {
  it('renders the new tabs + controls and NONE of the legacy form/tabs', () => {
    render(page());
    // new structure
    expect(screen.getByRole('tab', { name: 'Feed' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Daybook' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Parties' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Job Cost' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Statements' })).toBeTruthy();
    expect(screen.getByTestId('capture-button')).toBeTruthy();
    expect(screen.getByTestId('period-label')).toBeTruthy();
    expect(screen.getByTestId('fy-chip')).toBeTruthy();
    expect(screen.getByTestId('parity-chip')).toBeTruthy();
    // legacy All/Debits/Credits tabs are gone
    expect(screen.queryByRole('tab', { name: 'All' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Debits' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Credits' })).toBeNull();
    // trial balance indicator lives on Statements (click through)
    fireEvent.click(screen.getByRole('tab', { name: 'Statements' }));
    expect(screen.getByTestId('trial-balance').dataset.balanced).toBe('true');
  });
});

describe('PDF export prints the ledger sheet itself', () => {
  it('prints the open tab with its letterhead and period header', async () => {
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});
    render(page());

    fireEvent.click(screen.getByTestId('export-pdf'));
    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));

    const printed = document.getElementById('print-root');
    expect(printed?.textContent).toContain('Your company name');
    expect(printed?.textContent).toContain('Ledger');
    expect(printed?.textContent).toContain('Period:');
    // The page around the sheet (title + subtitle) is not printed.
    expect(printed?.textContent).not.toContain('Double-entry books');

    window.dispatchEvent(new Event('afterprint'));
    printSpy.mockRestore();
  });

  it('registers the open view so File → Print prints the sheet, not app chrome', () => {
    render(page());
    expect(currentPrintTarget()?.el).toBe(screen.getByTestId('ledger-sheet'));
  });
});

describe('72. every hopper type shows ONLY its fields', () => {
  const CASES: { type: string; has: string[]; hasnt: string[] }[] = [
    { type: 'supplier-bill', has: ['Supplier', 'Cost category', 'Due days'], hasnt: ['Worker', 'Method', 'Retention %', 'Debit account', 'Qty', 'Rate'] },
    { type: 'payment-supplier', has: ['Supplier', 'Amount', 'Method', 'Withholding (optional)'], hasnt: ['Qty', 'Category', 'Worker', 'Retention %'] },
    { type: 'client-receipt', has: ['Client', 'Amount', 'Method', 'Retention released'], hasnt: ['Supplier', 'Qty', 'Category', 'Worker'] },
    { type: 'client-invoice', has: ['Client', 'Retention %', 'Project'], hasnt: ['Supplier', 'Method', 'Category', 'Worker', 'Amount'] },
    { type: 'expense-paid', has: ['Category', 'Amount', 'Method', 'Project (optional → overhead)'], hasnt: ['Supplier', 'Qty', 'Worker', 'Retention %'] },
    { type: 'worker-advance', has: ['Worker', 'Amount', 'Method'], hasnt: ['Supplier', 'Category', 'Client', 'Retention %'] },
    { type: 'transfer', has: ['From', 'To', 'Amount'], hasnt: ['Category', 'Supplier', 'Client', 'Worker'] },
    { type: 'owner-loan-in', has: ['Source', 'Amount', 'Method'], hasnt: ['Category', 'Supplier', 'Client', 'Worker'] },
    { type: 'adjustment', has: ['Debit account', 'Credit account', 'Amount'], hasnt: ['Category', 'Supplier', 'Client', 'Worker'] },
  ];

  it('type grid + settle-payroll link card exist; each fieldset shows only its own fields', () => {
    render(page());
    fireEvent.click(screen.getByTestId('capture-button'));
    // type card grid (S3.1) + link card with no form (S3.2)
    expect(screen.getByTestId('type-grid')).toBeTruthy();
    for (const c of CASES) expect(screen.getByTestId(`type-${c.type}`)).toBeTruthy();
    expect(screen.getByTestId('settle-payroll')).toBeTruthy();

    for (const c of CASES) {
      fireEvent.click(screen.getByTestId(`type-${c.type}`));
      for (const label of c.has) expect(screen.getByLabelText(label), `${c.type} needs "${label}"`).toBeTruthy();
      // bills and invoices take their money from the item table, not one amount
      const itemDoc = ['supplier-bill', 'client-invoice'].includes(c.type);
      expect(Boolean(screen.queryByTestId('items-editor'))).toBe(itemDoc);
      for (const label of c.hasnt) expect(screen.queryByLabelText(label), `${c.type} must NOT show "${label}"`).toBeNull();
      // shared fields always visible (S3.1)
      expect(screen.getByLabelText('Date (A.D.)')).toBeTruthy();
      expect(screen.getByLabelText('Reference')).toBeTruthy();
      expect(screen.getByLabelText('Note')).toBeTruthy();
      expect(screen.getByLabelText('Attachment')).toBeTruthy();
      // back to the grid for the next type
      fireEvent.click(screen.getByText('change type'));
    }
  });

  it('labour categories are absent from the Category list with a pointer to Labour (S0.3)', () => {
    render(page());
    fireEvent.click(screen.getByTestId('capture-button'));
    fireEvent.click(screen.getByTestId('type-expense-paid'));
    const select = screen.getByLabelText('Category') as HTMLSelectElement;
    const options = [...select.options].map((o) => o.value);
    expect(options).not.toContain('Labour');
    expect(options).not.toContain('Salary');
    expect(screen.getByText(/Labour & salary lines are owned by payroll/i)).toBeTruthy();
  });

  it('routing preview lines are IDENTICAL to the saved lines (preview == truth)', () => {
    render(page());
    fireEvent.click(screen.getByTestId('capture-button'));
    fireEvent.click(screen.getByTestId('type-expense-paid'));
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Transport' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '5000' } });
    fireEvent.change(screen.getByLabelText('Method'), { target: { value: 'bank' } });

    // live preview (S3.3) — captured BEFORE save
    const preview = JSON.parse(screen.getByTestId('routing-json').textContent!);
    expect(preview).toHaveLength(2);

    fireEvent.click(screen.getByTestId('save-entry'));

    // saved entry lines must match the preview byte-for-byte
    const entries = allEntries();
    expect(entries).toHaveLength(1);
    const lines = linesOf(entries[0].id);
    const saved = lines.map((l) => ({ a: l.account_id, d: l.debit, c: l.credit, p: l.party_id, w: l.worker_id, j: l.project_id }));
    expect(saved).toEqual(preview);
    // toast summarizes the routing (S3.4)
    expect(screen.getByTestId('toast').textContent).toContain(`Entry ${entries[0].id}`);
    expect(screen.getByTestId('toast').textContent).toContain('Transport');
    // Feed updates
    expect(screen.getByTestId(`feed-row-${entries[0].id}`)).toBeTruthy();
  });
});

describe('63. trial balance red blocks exports and shows a banner', () => {
  it('an imbalanced line store disables CSV/PDF and shows both banners', () => {
    // corrupt the line store directly (bypassing the engine) to force red
    localStorage.setItem(
      'contractoros_entry_lines',
      JSON.stringify([
        { id: 'x#1', entry_id: 'x', account_id: 'acc:cash', party_id: '', worker_id: '', project_id: '', cost_code: '', debit: 100, credit: 0, memo: '', bill_link_id: '' },
        { id: 'x#2', entry_id: 'x', account_id: 'acc:capital', party_id: '', worker_id: '', project_id: '', cost_code: '', debit: 0, credit: 50, memo: '', bill_link_id: '' },
      ])
    );
    render(page());
    // controls-bar banner + blocked exports (S6.3)
    expect(screen.getByTestId('tb-export-block')).toBeTruthy();
    expect((screen.getByTestId('export-csv') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('export-pdf') as HTMLButtonElement).disabled).toBe(true);
    // Statements: indicator red + blocking banner
    fireEvent.click(screen.getByRole('tab', { name: 'Statements' }));
    expect(screen.getByTestId('trial-balance').dataset.balanced).toBe('false');
    expect(screen.getByTestId('tb-banner')).toBeTruthy();
  });
});

describe('74. auto-entries are read-only in Feed with jump links (S5.3)', () => {
  it('billing + payroll entries show source badges and jump buttons, never Edit', () => {
    const today = todayAD();
    const inv = billingInvoiceEntry({ billId: 'B-77', client: 'Gyan Constructions', amount: 9000, date: today })!;
    payrollAccrualEntry({
      date: today,
      ref: 'PR-TEST',
      workers: [{ worker_id: 'w1', name: 'Rajesh', amount: 1000 }],
      project_splits: [{ project_id: 'PRJ-001', amount: 1000 }],
    });
    const nav = vi.fn();
    render(page(nav));

    // billing entry drawer: jump, no edit
    fireEvent.click(screen.getByTestId(`feed-row-${inv.id}`));
    expect(screen.getByTestId('drawer-source').textContent).toBe('billing');
    expect(screen.getByTestId('drawer-jump')).toBeTruthy();
    expect(screen.queryByTestId('drawer-edit')).toBeNull();
    fireEvent.click(screen.getByTestId('drawer-jump'));
    expect(nav).toHaveBeenCalledWith('billing');
    fireEvent.click(screen.getByText('Close'));

    // payroll entry drawer: jump, no edit
    const payrollEntry = allEntries().find((e) => e.ref === 'PR-TEST')!;
    fireEvent.click(screen.getByTestId(`feed-row-${payrollEntry.id}`));
    expect(screen.getByTestId('drawer-source').textContent).toBe('payroll');
    expect(screen.getByTestId('drawer-jump')).toBeTruthy();
    expect(screen.queryByTestId('drawer-edit')).toBeNull();
    fireEvent.click(screen.getByTestId('drawer-jump'));
    expect(nav).toHaveBeenCalledWith('attendance');
  });

  it('a manual entry is editable and regenerates lines with history (75 UI)', () => {
    const today = todayAD();
    render(page());
    fireEvent.click(screen.getByTestId('capture-button'));
    fireEvent.click(screen.getByTestId('type-expense-paid'));
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Utilities' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '300' } });
    fireEvent.click(screen.getByTestId('save-entry'));
    const entry = allEntries()[0];

    fireEvent.click(screen.getByTestId(`feed-row-${entry.id}`));
    expect(screen.getByTestId('drawer-edit')).toBeTruthy();
    expect(screen.queryByTestId('drawer-jump')).toBeNull();
    fireEvent.click(screen.getByTestId('drawer-edit'));

    // hopper opens in edit mode with a reason field
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '450' } });
    fireEvent.change(screen.getByLabelText('Edit reason (recorded in audit)'), { target: { value: 'wrong amount' } });
    fireEvent.click(screen.getByTestId('save-entry'));

    const lines = linesOf(entry.id);
    expect(lines.reduce((s, l) => s + l.debit, 0)).toBe(450);
    // reopen the drawer: history badge + audit reason are both there
    fireEvent.click(screen.getByTestId(`feed-row-${entry.id}`));
    expect(screen.getByTestId('edit-history-count')).toBeTruthy();
    expect(screen.getByTestId('edit-history').textContent).toContain('wrong amount');
    expect(getAudit().some((a) => a.action === 'edit' && a.reason === 'wrong amount')).toBe(true);
  });
});

describe('76. locked period rejects save with a message; unlock logs the reason', () => {
  it('lock → save shows the locked message; unlock with reason → save succeeds', () => {
    render(page());
    // lock the current period from the controls bar
    fireEvent.change(screen.getByTestId('lock-reason'), { target: { value: 'Books closed' } });
    fireEvent.click(screen.getByTestId('lock-button'));
    expect(screen.getByTestId('lock-state').dataset.locked).toBe('true');

    // hopper save is rejected with the locked message (S6.1)
    fireEvent.click(screen.getByTestId('capture-button'));
    fireEvent.click(screen.getByTestId('type-expense-paid'));
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Transport' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '100' } });
    fireEvent.click(screen.getByTestId('save-entry'));
    expect(screen.getByTestId('hopper-error').textContent).toMatch(/locked/i);
    expect(allEntries()).toHaveLength(0);

    // unlock with a reason → audit log records it, save now works
    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.change(screen.getByTestId('lock-reason'), { target: { value: 'Reopened for correction' } });
    fireEvent.click(screen.getByTestId('unlock-button'));
    expect(screen.getByTestId('lock-state').dataset.locked).toBe('false');
    expect(
      getAudit().some((a) => a.action === 'unlock' && a.reason === 'Reopened for correction')
    ).toBe(true);

    fireEvent.click(screen.getByTestId('capture-button'));
    fireEvent.click(screen.getByTestId('type-expense-paid'));
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Transport' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '100' } });
    fireEvent.click(screen.getByTestId('save-entry'));
    expect(allEntries()).toHaveLength(1);
  });
});
