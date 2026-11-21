// @vitest-environment jsdom
// The print pipeline is the one place that decides what paper sees. These
// tests pin the contract: the clone carries the sheet's own content, it is the
// only thing on the printed page, the dialog is opened exactly once, and every
// trace of printing is removed afterwards.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  currentPrintTarget,
  registerPrintTarget,
  printCurrentTarget,
  printSheet,
} from './printService';

let printSpy: ReturnType<typeof vi.spyOn>;

function makeSheet(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'sheet-source';
  el.setAttribute('data-testid', 'source-sheet');
  el.innerHTML =
    '<h1>TAX INVOICE INV-001</h1>' +
    '<table><thead><tr><th>Item</th></tr></thead><tbody><tr><td>Cement</td></tr></tbody></table>' +
    '<input value="typed by the user" />';
  document.body.appendChild(el);
  return el;
}

const finishPrinting = () => window.dispatchEvent(new Event('afterprint'));

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.querySelectorAll('#print-page-style').forEach((node) => node.remove());
  document.title = 'Stambha';
  document.documentElement.className = '';
  printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});
});

afterEach(() => {
  finishPrinting();
  printSpy.mockRestore();
});

describe('printSheet', () => {
  it('prints a clone of the given sheet, not the app page', async () => {
    const source = makeSheet();
    const ok = await printSheet(source, { title: 'TAX INVOICE INV-001' });

    expect(ok).toBe(true);
    const root = document.getElementById('print-root');
    expect(root).toBeTruthy();
    expect(root!.querySelector('[data-print-sheet]')).toBeTruthy();
    expect(root!.textContent).toContain('TAX INVOICE INV-001');
    expect(root!.textContent).toContain('Cement');
    // Live wiring is not duplicated into the printed copy.
    expect(root!.querySelector('#sheet-source')).toBeNull();
    expect(root!.querySelector('[data-testid="source-sheet"]')).toBeNull();
    // Form fields print their value, not an empty box.
    expect(root!.querySelector('input')).toBeNull();
    expect(root!.textContent).toContain('typed by the user');
    // Only the Gantt asks for width fitting; a document sheet keeps 100%.
    expect(root!.querySelector('[data-print-fit]')).toBeNull();
    // Paper geometry is applied for this one print only.
    expect(document.getElementById('print-page-style')?.textContent).toContain('portrait');
  });

  it('opens the print dialog exactly once and restores the document title', async () => {
    const source = makeSheet();
    await printSheet(source, { title: 'Purchase Register 2083/06' });
    expect(printSpy).toHaveBeenCalledTimes(1);
    // Slashes are illegal in file names, so the title is sanitised for the PDF.
    expect(document.title).toBe('Purchase Register 2083-06');

    finishPrinting();
    expect(document.title).toBe('Stambha');
    expect(document.getElementById('print-root')?.childElementCount).toBe(0);
    expect(document.getElementById('print-page-style')).toBeNull();
    expect(document.documentElement.classList.contains('printing')).toBe(false);
  });

  it('prints landscape when the sheet is wide', async () => {
    await printSheet(makeSheet(), { landscape: true });
    expect(document.getElementById('print-page-style')?.textContent).toContain('landscape');
    expect(document.documentElement.classList.contains('print-landscape')).toBe(true);
  });

  it('refuses a second dialog while one is open', async () => {
    const source = makeSheet();
    const first = await printSheet(source);
    const second = await printSheet(source);
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(printSpy).toHaveBeenCalledTimes(1);
    finishPrinting();
  });

  it('scales a sheet wider than the paper onto the printable width', async () => {
    // jsdom has no layout: pretend the sheet needs 2000px of paper width.
    const widthSpy = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(2000);
    await printSheet(makeSheet(), { landscape: true, fitWidth: true });

    const sheet = document.querySelector<HTMLElement>('#print-root [data-print-fit="width"]');
    expect(sheet).toBeTruthy();
    // A4 landscape printable width is 277mm ≈ 1046px, so 1046/2000 ≈ 0.523.
    const scale = Number(sheet!.style.getPropertyValue('--print-fit-scale'));
    expect(scale).toBeGreaterThan(0.5);
    expect(scale).toBeLessThan(0.55);
    expect(sheet!.style.getPropertyValue('--print-content-width')).toBe('2000px');

    widthSpy.mockRestore();
    finishPrinting();
  });

  it('leaves a sheet that already fits the page at full size', async () => {
    const widthSpy = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(500);
    await printSheet(makeSheet(), { landscape: true, fitWidth: true });

    const sheet = document.querySelector<HTMLElement>('#print-root [data-print-fit="width"]');
    expect(sheet).toBeTruthy();
    expect(Number(sheet!.style.getPropertyValue('--print-fit-scale'))).toBe(1);
    expect(sheet!.style.getPropertyValue('--print-content-width')).toBe('');

    widthSpy.mockRestore();
    finishPrinting();
  });

  it('does nothing, and says so, when there is no sheet', async () => {
    const ok = await printSheet(null);
    expect(ok).toBe(false);
    expect(printSpy).not.toHaveBeenCalled();
    expect(document.getElementById('print-root')?.childElementCount ?? 0).toBe(0);
  });
});

describe('print targets', () => {
  it('prints the live sheet a page registered', async () => {
    const source = makeSheet();
    const unregister = registerPrintTarget(() => ({ el: source, title: 'Daily Site Report', landscape: false }));

    expect(currentPrintTarget()?.el).toBe(source);
    await printCurrentTarget();
    expect(document.getElementById('print-root')?.textContent).toContain('Cement');
    expect(document.title).toBe('Daily Site Report');

    unregister();
    expect(currentPrintTarget()).toBeNull();
    finishPrinting();
  });

  it('falls back to the page content when nothing is registered', async () => {
    const main = document.createElement('main');
    main.textContent = 'Ledger page';
    document.body.appendChild(main);

    const ok = await printCurrentTarget();
    expect(ok).toBe(true);
    expect(document.getElementById('print-root')?.textContent).toContain('Ledger page');
    finishPrinting();
  });
});
