// @vitest-environment jsdom
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import GanttPage from './Gantt';
import { todayISO, addDaysISO, loadActivities, ganttListCsv } from '../services/dsrSyncService';
import { adToBS, formatBS } from '../utils/nepaliDate';

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const BOQ = [
  {
    sectionCode: 'A',
    description: 'Earthworks',
    children: [
      { itemCode: 'A.01', description: 'Excavation', unit: 'm3', estimatedQuantity: 100, rate: 100 },
      { itemCode: 'A.02', description: 'Backfill', unit: 'm3', estimatedQuantity: 50, rate: 80 },
    ],
  },
];
const TODAY = todayISO();
const MILESTONES = [
  { id: 'm1', name: 'Foundation done', boqCode: 'A.01', startDate: addDaysISO(TODAY, -10), endDate: addDaysISO(TODAY, -5) },
  { id: 'm2', name: 'Backfill done', boqCode: 'A.02', startDate: addDaysISO(TODAY, -10), endDate: addDaysISO(TODAY, -5) },
];

const dsr = (id: string, date: string, boqCode: string, workQuantity: number) => ({ id, date, boqCode, workQuantity });

function page(dsrData: any[]) {
  return <GanttPage boqData={BOQ} dsrData={dsrData} milestones={MILESTONES} timezone="Asia/Kathmandu" />;
}

function adPretty(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

function bsPretty(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return formatBS(adToBS(new Date(Date.UTC(y, m - 1, d, 12))));
}

it('prints the chart sheet (not a blank page)', async () => {
  const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});
  render(page([dsr('d1', addDaysISO(TODAY, -8), 'A.01', 40)]));

  fireEvent.click(screen.getByText('Print / PDF'));
  await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));

  const printed = document.getElementById('print-root');
  expect(printed?.textContent).toContain('Excavation');
  // The Gantt is the one sheet that asks the pipeline to scale it onto the
  // printable width; the rule is scoped to this clone's data attribute.
  const sheet = printed?.querySelector('[data-print-fit="width"]');
  expect(sheet).toBeTruthy();
  expect(sheet!.getAttribute('class')).toContain('print-sheet');
  window.dispatchEvent(new Event('afterprint'));
  printSpy.mockRestore();
});

it('F1: DSR entry updates progress fill, status chip, tooltip and left-pane % with no Gantt edit', () => {
  const { container, rerender } = render(page([dsr('d1', addDaysISO(TODAY, -8), 'A.01', 40)]));
  let row = container.querySelector('[data-act-row="act:A.01"]')!;
  expect(row.getAttribute('data-progress')).toBe('40');
  expect(row.querySelector('[data-progress-pct]')!.textContent).toBe('40%');
  expect((row.querySelector('[data-progress-fill]') as HTMLElement).style.width).toBe('40%');
  expect(row.querySelector('[data-status-chip]')!.textContent).toBe('Delayed'); // derived, C3
  expect(row.getAttribute('data-status')).toBe('delayed');

  fireEvent.mouseEnter(row.querySelector('[data-act-bar]')!);
  const tip = container.querySelector('[data-testid="gantt-tooltip"]')!;
  expect(tip.textContent).toContain('Progress');
  expect(tip.textContent).toContain('40%');
  expect(tip.textContent).toContain(adPretty(addDaysISO(TODAY, -8))); // actual start, AD + BS
  expect(tip.textContent).toContain(bsPretty(addDaysISO(TODAY, -8)));
  fireEvent.mouseLeave(row.querySelector('[data-act-bar]')!);

  // more DSR comes in → 100% / Done without touching the Gantt
  rerender(page([
    dsr('d1', addDaysISO(TODAY, -8), 'A.01', 40),
    dsr('d2', addDaysISO(TODAY, -6), 'A.01', 60),
  ]));
  row = container.querySelector('[data-act-row="act:A.01"]')!;
  expect(row.getAttribute('data-progress')).toBe('100');
  expect(row.querySelector('[data-progress-pct]')!.textContent).toBe('100%');
  expect((row.querySelector('[data-progress-fill]') as HTMLElement).style.width).toBe('100%');
  expect(row.querySelector('[data-status-chip]')!.textContent).toBe('Done');
});

it('F2: DSR before planned start raises a sync alert; removing it clears the alert', () => {
  const { rerender } = render(page([dsr('e1', addDaysISO(TODAY, -20), 'A.01', 10)]));
  const strip = screen.getByTestId('gantt-alerts');
  expect(strip.textContent).toContain('before its planned start');
  expect(strip.textContent).toContain('Excavation');
  rerender(page([]));
  expect(screen.queryByTestId('gantt-alerts')).toBeNull();
});

it('F3: delayed activity renders red-hatch and tooltip shows forecast from avg daily output', () => {
  const { container } = render(page([dsr('d1', addDaysISO(TODAY, -8), 'A.01', 40)]));
  const row = container.querySelector('[data-act-row="act:A.01"]')!;
  expect(row.getAttribute('data-status')).toBe('delayed');
  const bar = row.querySelector('[data-act-bar="act:A.01"]') as HTMLElement;
  expect(bar.className).toContain('repeating-linear-gradient'); // red-hatch
  fireEvent.mouseEnter(bar);
  const tip = container.querySelector('[data-testid="gantt-tooltip"]')!;
  const forecast = addDaysISO(TODAY, 2); // remaining 60 / avg 40 per day → +2
  expect(tip.textContent).toContain(adPretty(forecast));
  expect(tip.textContent).toContain(bsPretty(forecast));
  fireEvent.mouseLeave(bar);
  expect(screen.getByTestId('gantt-alerts').textContent).toContain('Forecast slip +7d');
});

it('F4: milestone diamond flips done with actual date; Milestones view shows 0 remaining', () => {
  const { container } = render(page([dsr('d7', addDaysISO(TODAY, -7), 'A.01', 100)]));
  const msRow = container.querySelector('[data-act-row="ms:m1"]')!;
  expect(msRow.getAttribute('data-status')).toBe('done');

  fireEvent.click(screen.getByRole('button', { name: 'Milestones' }));
  const card = container.querySelector('[data-milestone-card="ms:m1"]')!;
  expect(card.textContent).toContain('Done');
  expect(card.querySelector('[data-milestone-actual]')!.textContent).toBe(addDaysISO(TODAY, -7));
  expect(card.querySelector('[data-milestone-remaining]')!.textContent).toBe('0 days');
  const other = container.querySelector('[data-milestone-card="ms:m2"]')!;
  expect(other.querySelector('[data-milestone-actual]')).toBeNull();
  expect(other.querySelector('[data-milestone-remaining]')!.textContent).toMatch(/overdue|\d+d remaining/);
});

it('F5: zoom Day/Week/Month/Fit keeps today line on a column boundary and all marks aligned', () => {
  const { container } = render(page([]));
  const barCount = container.querySelectorAll('[data-act-bar]').length;
  const arrowCount = container.querySelectorAll('[data-dep-arrow]').length;
  expect(barCount).toBe(4); // 2 bars + 2 diamonds
  expect(arrowCount).toBe(3);
  expect(screen.getByTestId('today-line')).toBeTruthy();
  expect(screen.getByTestId('today-line-header')).toBeTruthy();
  expect(screen.getByTestId('gantt-legend')).toBeTruthy();

  const rowsLine = container.querySelector('[data-testid="today-line"]') as HTMLElement;
  const headerLine = container.querySelector('[data-testid="today-line-header"]') as HTMLElement;
  const expected: Record<string, string> = { Day: '32px', Week: '14px', Month: '7px' };
  for (const label of ['Day', 'Week', 'Month'] as const) {
    fireEvent.click(screen.getByLabelText(`Zoom ${label}`));
    const tick = container.querySelector('[data-day-tick]') as HTMLElement;
    expect(tick.style.width).toBe(expected[label]);
    const left = parseFloat(rowsLine.style.left);
    expect(left - 320).toBe(parseFloat(headerLine.style.left)); // one shared scale (B1)
    expect((left - 320) % parseFloat(tick.style.width)).toBe(0); // inside a whole day column
    expect(container.querySelectorAll('[data-act-bar]').length).toBe(barCount);
    expect(container.querySelectorAll('[data-dep-arrow]').length).toBe(arrowCount);
  }
  fireEvent.click(screen.getByLabelText('Zoom Fit'));
  const days = container.querySelectorAll('[data-day-tick]').length;
  const fitTick = container.querySelector('[data-day-tick]') as HTMLElement;
  expect(parseFloat(fitTick.style.width)).toBe(Math.floor(580 / days)); // container 900 − 320 left pane
  expect(container.querySelectorAll('[data-act-bar]').length).toBe(barCount);
  expect(container.querySelectorAll('[data-dep-arrow]').length).toBe(arrowCount);
});

it('F6: every dependency renders an arrow, critical toggle outlines the exact CPM chain, no raw codes', () => {
  const { container } = render(page([]));
  const arrows = container.querySelectorAll('[data-dep-arrow]');
  expect(arrows.length).toBe(3);

  // no raw dependency codes anywhere in the rendered UI
  const html = container.innerHTML;
  expect(html).not.toMatch(/:FS|:SS|:FF|:SF|FS\+|SS\+/);
  // plain-language tooltips instead
  fireEvent.mouseEnter(container.querySelector('[data-act-row="act:A.02"] [data-act-bar]')!);
  expect(container.querySelector('[data-testid="gantt-tooltip"]')!.textContent).toContain('after: Excavation');
  fireEvent.mouseLeave(container.querySelector('[data-act-row="act:A.02"] [data-act-bar]')!);

  fireEvent.click(screen.getByTestId('critical-toggle'));
  const critical = [...container.querySelectorAll('[data-act-bar]')]
    .filter((el) => el.className.includes('ring-red-600'))
    .map((el) => el.getAttribute('data-act-bar'))
    .sort();
  // longest chain A.01 → A.02 → ms:m2; the short milestone branch ms:m1 has float
  expect(critical).toEqual(['act:A.01', 'act:A.02', 'ms:m2']);
  expect(container.querySelector('[data-act-row="ms:m1"] [data-act-bar]')!.className).not.toContain('ring-red-600');
});

it('F8: row drawer lists the DSR history read-only, newest first, with AD + BS dates', () => {
  const { container } = render(page([
    dsr('d1', addDaysISO(TODAY, -8), 'A.01', 20),
    dsr('d2', addDaysISO(TODAY, -6), 'A.01', 20),
  ]));
  fireEvent.click(container.querySelector('[data-act-row="act:A.01"]')!.firstElementChild!);
  const drawer = screen.getByTestId('gantt-drawer');
  expect(drawer.querySelectorAll('input, textarea, select, button[aria-label="Save"]').length).toBe(0); // read-only
  expect(screen.getByTestId('drawer-status')).toBeTruthy();
  expect(drawer.textContent).toContain('Excavation'); // linked BOQ item
  const history = screen.getByTestId('drawer-dsr-history');
  expect(history.children).toHaveLength(2);
  expect(history.children[0].textContent).toContain(adPretty(addDaysISO(TODAY, -6))); // newest first
  expect(history.children[1].textContent).toContain(adPretty(addDaysISO(TODAY, -8)));
  expect(history.children[0].textContent).toContain(bsPretty(addDaysISO(TODAY, -6))); // B.S.
  fireEvent.click(screen.getByLabelText('Close drawer'));
  expect(screen.queryByTestId('gantt-drawer')).toBeNull();
});

it('F9: List view shows a slip column and its CSV carries bs_date/ad_date/progress/slip', () => {
  const { container } = render(page([dsr('d1', addDaysISO(TODAY, -8), 'A.01', 40)]));
  fireEvent.click(screen.getByRole('button', { name: 'List' }));
  const list = screen.getByTestId('gantt-list');
  expect(list.textContent).toContain('Slip');
  expect(list.textContent).toContain('End (B.S.)');
  expect(list.querySelector('[data-list-slip="act:A.01"]')!.textContent).toBe('0d');
  expect(list.querySelector('[data-list-row="act:A.01"]')!.textContent).toContain('40%');
  const csv = ganttListCsv(loadActivities());
  const header = csv.split('\n')[0];
  for (const col of ['bs_date', 'ad_date', 'progress', 'slip_days']) expect(header).toContain(col);
});
