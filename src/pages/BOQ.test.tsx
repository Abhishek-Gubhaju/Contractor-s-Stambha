// @vitest-environment jsdom
import React, { useState } from 'react';
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import BOQPage from './BOQ';
import { DialogHost } from '../components/ui/DialogHost';
import type { AppBOQSection } from '../types';
import { seedSignedInUser, TEST_PASSCODE } from '../testUtils/seedAuth';

afterEach(cleanup);
beforeEach(() => localStorage.clear());

function Harness({ initial }: { initial: AppBOQSection[] }) {
  const [boqData, setBoqData] = useState<AppBOQSection[]>(initial);
  return (
    <>
      <BOQPage boqData={boqData} setBoqData={setBoqData} />
      <DialogHost />
    </>
  );
}

const seeded = (): AppBOQSection[] => [
  {
    id: 's-1',
    sectionCode: 'R',
    description: 'Road works',
    amount: 550000,
    isSection: true,
    children: [
      {
        id: 'i-1',
        sectionCode: 'R',
        itemCode: 'R-101',
        description: 'Earthwork',
        unit: 'cum',
        estimatedQuantity: 1000,
        rate: 550,
        amount: 550000,
        actualMaterialCost: 0,
        actualLaborCost: 0,
        completedQuantity: 0,
      },
    ],
  },
];

const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('BOQ page — the empty document', () => {
  it('starts with a section instead of a dead Add Item button', () => {
    render(<Harness initial={[]} />);
    expect(screen.getByTestId('boq-empty')).toBeTruthy();

    // The reported bug: no section exists, so the item form could never submit.
    fireEvent.click(screen.getByTestId('add-item'));
    expect(screen.getByText(/belongs to a section, and this BOQ has none yet/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /create the first section/i }));

    fill('Section code', 'R');
    fill('Description', 'Road and bridge works');
    fireEvent.click(screen.getByRole('button', { name: 'Add section' }));

    // Creating a section takes the person straight to its first item.
    expect(screen.getByRole('heading', { name: /add new boq item/i })).toBeTruthy();
    const sectionSelect = screen.getByLabelText('Section') as HTMLSelectElement;
    expect(sectionSelect.value).not.toBe('');

    fill('Item code', 'R-101');
    fill('Description', 'Earthwork excavation');
    fill('Unit', 'cum');
    fill('Quantity', '1000');
    fill('Rate (NRS)', '550');
    fireEvent.click(screen.getByRole('button', { name: 'Add Item' }));

    expect(screen.queryByRole('heading', { name: /add new boq item/i })).toBeNull();
    expect(screen.getByText('R-101')).toBeTruthy();
    expect(screen.getByText('Earthwork excavation')).toBeTruthy();
    expect(screen.getAllByText('NRS 550,000').length).toBeGreaterThan(0);
  });
});

describe('BOQ page — validation', () => {
  it('explains what is missing instead of doing nothing', () => {
    render(<Harness initial={seeded()} />);
    fireEvent.click(screen.getByTestId('add-item'));
    fireEvent.click(screen.getByRole('button', { name: 'Add Item' }));

    const errors = screen.getByTestId('boq-item-errors');
    expect(errors.textContent).toContain('An item code is required.');
    expect(errors.textContent).toContain('A description is required.');
    expect(errors.textContent).toContain('A unit is required');
    expect(errors.textContent).toContain('Enter the estimated quantity as a number.');
    expect(errors.textContent).toContain('Enter the rate as a number.');
    expect(screen.getByRole('heading', { name: /add new boq item/i })).toBeTruthy(); // stays open

    // Editing a field clears the stale complaints; the next submit re-checks
    // everything, so nothing is left on screen claiming a fixed field is wrong.
    fill('Item code', 'R-102');
    expect(screen.queryByTestId('boq-item-errors')).toBeNull();
    expect(screen.queryByText('An item code is required.')).toBeNull();
  });

  it('blocks duplicate codes across the whole BOQ', () => {
    render(<Harness initial={seeded()} />);
    fireEvent.click(screen.getByTestId('add-item'));
    fill('Item code', ' r-101 ');
    fill('Description', 'Duplicate');
    fill('Unit', 'cum');
    fill('Quantity', '1');
    fill('Rate (NRS)', '1');
    fireEvent.click(screen.getByRole('button', { name: 'Add Item' }));
    expect(screen.getByTestId('boq-item-errors').textContent).toMatch(/already used/i);
  });

  it('rejects a negative quantity', () => {
    render(<Harness initial={seeded()} />);
    fireEvent.click(screen.getByTestId('add-item'));
    fill('Item code', 'R-102');
    fill('Description', 'Backfill');
    fill('Unit', 'cum');
    fill('Quantity', '-5');
    fill('Rate (NRS)', '10');
    fireEvent.click(screen.getByRole('button', { name: 'Add Item' }));
    expect(screen.getByTestId('boq-item-errors').textContent).toMatch(/cannot be negative/i);
  });

  it('rejects a duplicate section code', () => {
    render(<Harness initial={seeded()} />);
    fireEvent.click(screen.getByTestId('add-section'));
    fill('Section code', 'r');
    fill('Description', 'Another road section');
    fireEvent.click(screen.getByRole('button', { name: 'Add section' }));
    expect(screen.getByTestId('boq-section-errors').textContent).toMatch(/already used/i);
  });
});

describe('BOQ page — editing and deleting', () => {
  it('edits the contract figures and recalculates the amount and total', () => {
    render(<Harness initial={seeded()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit item R-101' }));
    fill('Quantity', '1200');
    fill('Rate (NRS)', '600');
    expect(screen.getByTestId('boq-item-amount-preview').textContent).toContain('720,000');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(screen.getAllByText('NRS 720,000').length).toBeGreaterThan(0);
    expect(screen.queryByText('NRS 550,000')).toBeNull();
  });

  it('deletes an item after the passcode is confirmed', async () => {
    await seedSignedInUser();
    render(<Harness initial={seeded()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete item R-101' }));
    const dialog = await screen.findByTestId('destroy-dialog');
    fireEvent.change(within(dialog).getByTestId('destroy-secret'), { target: { value: TEST_PASSCODE } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete item' }));

    await waitFor(() => expect(screen.queryByText('R-101')).toBeNull());
    expect(screen.getAllByText('NRS 0').length).toBeGreaterThan(0);
  });

  it('renames a section and shows the count of items in it', () => {
    render(<Harness initial={seeded()} />);
    expect(screen.getByText('1 item')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rename section R' }));
    fill('Section code', 'RD');
    fill('Description', 'Road works (revised)');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByText('Road works (revised)')).toBeTruthy();
    expect(screen.getAllByText('RD').length).toBeGreaterThan(0);
  });

  it('deletes a section with all of its items after the passcode is confirmed', async () => {
    await seedSignedInUser();
    render(<Harness initial={seeded()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete section R' }));
    const dialog = await screen.findByTestId('destroy-dialog');
    expect(dialog.textContent).toMatch(/its 1 item/i);
    fireEvent.change(within(dialog).getByTestId('destroy-secret'), { target: { value: TEST_PASSCODE } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete section' }));
    await waitFor(() => expect(screen.getByTestId('boq-empty')).toBeTruthy());
  });

  it('moves an item to another section from the edit form', async () => {
    const bridge: AppBOQSection = {
      id: 's-2',
      sectionCode: 'B',
      description: 'Bridge works',
      amount: 0,
      isSection: true,
      children: [],
    };
    render(<Harness initial={[...seeded(), bridge]} />);
    expect(screen.getByText('0 items')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Edit item R-101' }));
    const sectionSelect = screen.getByLabelText('Section') as HTMLSelectElement;
    fireEvent.change(sectionSelect, { target: { value: 's-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.queryByRole('heading', { name: /edit boq item/i })).toBeNull());
    expect(within(screen.getByText('Bridge works').closest('tr')!).getByText('1 item')).toBeTruthy();
    expect(within(screen.getByText('Road works').closest('tr')!).getByText('0 items')).toBeTruthy();
    expect(screen.getAllByText('R-101')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Edit item R-101' })).toBeTruthy();
  });
});
