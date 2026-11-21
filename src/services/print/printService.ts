// ============================================================================
// printService — ONE print pipeline for every document in the app.
//
// The rule is: what prints is exactly what the preview shows. So we do not
// re-render a document from data (that is how previews and paper drift apart),
// and we do not print a page full of app chrome. We CLONE the sheet the user is
// looking at into `#print-root`, print that DOM, and remove it afterwards.
//
// Why a clone instead of printing the live sheet:
//   • the sheet usually lives inside a modal (position: fixed, overflow: auto)
//     under an app shell that is `h-screen overflow-hidden` — those ancestors
//     clip a long document to one page;
//   • a clone has no clipping ancestors, so tables flow across A4 pages and
//     `thead` repeats on each one;
//   • the clone keeps the same classes, so it is styled by the same stylesheet
//     and therefore looks identical to the preview.
//
// Transport (in order):
//   1. Desktop app on macOS → Tauri's own webview print (native print panel).
//   2. Everything else — Windows, Linux, browsers → window.print(), which Tauri
//      documents as working on all platforms and which opens the OS dialog.
// A transport failure is reported to the user; printing never fails silently.
// ============================================================================
import { notify } from '../../components/ui/DialogHost';
import { isDesktopApp, printWindowNative } from '../backup/desktop';

export interface PrintOptions {
  /** Document title — the default name the print/PDF dialog offers. */
  title?: string;
  /** Print on A4 landscape (wide registers, attendance grids, Gantt). */
  landscape?: boolean;
  /**
   * Shrink a sheet wider than the paper onto the printable width (the Gantt at
   * day/week zoom, where the chart is wider than A4 landscape). Applied to the
   * printed clone only; the live sheet on screen is never touched.
   */
  fitWidth?: boolean;
}

/** A print source registered by the page that is currently open. */
export interface PrintTarget {
  el: HTMLElement | null;
  title?: string;
  landscape?: boolean;
  fitWidth?: boolean;
}

const ROOT_ID = 'print-root';
const PAGE_STYLE_ID = 'print-page-style';
const SHEET_CLASS = 'print-sheet';
const PAGE_CLASS = 'printing';
const LANDSCAPE_CLASS = 'print-landscape';
/**
 * If `afterprint` never fires (some webviews), clear up anyway. Generous: the
 * person may sit in the print dialog choosing a printer or a PDF destination.
 */
const CLEANUP_MS = 10 * 60_000;

let inFlight = false;
let startedAt = 0;
let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
let previousTitle = '';
/** A dialog that never reports closing must not wedge printing forever. */
const IN_FLIGHT_MS = 30_000;

const targets: Array<() => PrintTarget> = [];

/**
 * Let the open page say "this is the sheet I show". The most recently
 * registered live target wins, so a modal's sheet beats the page behind it.
 */
export function registerPrintTarget(getter: () => PrintTarget): () => void {
  targets.push(getter);
  return () => {
    const index = targets.indexOf(getter);
    if (index >= 0) targets.splice(index, 1);
  };
}

/** The sheet Cmd+P should print on this page, if the page registered one. */
export function currentPrintTarget(): PrintTarget | null {
  for (let i = targets.length - 1; i >= 0; i -= 1) {
    const target = targets[i]();
    if (target?.el && target.el.isConnected) return target;
  }
  return null;
}

export function isPrinting(): boolean {
  return inFlight;
}

function printRoot(): HTMLElement {
  const existing = document.getElementById(ROOT_ID);
  if (existing) return existing;
  const root = document.createElement('div');
  root.id = ROOT_ID;
  document.body.appendChild(root);
  return root;
}

/**
 * The sheet as paper: same markup, same classes, minus the live wiring (ids and
 * aria-live would be duplicated in the document) and with form fields replaced
 * by the text they currently show.
 */
function cloneSheet(source: HTMLElement): HTMLElement {
  const clone = source.cloneNode(true) as HTMLElement;
  clone.removeAttribute('id');
  clone.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
  clone.querySelectorAll('[aria-live]').forEach((node) => node.removeAttribute('aria-live'));
  // The sheet stays queryable by its own test ids in tests; the clone is a
  // copy, so those ids would be ambiguous.
  clone.removeAttribute('data-testid');
  clone.querySelectorAll('[data-testid]').forEach((node) => node.removeAttribute('data-testid'));

  const sources = source.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    'input, textarea, select'
  );
  const fields = clone.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    'input, textarea, select'
  );
  fields.forEach((field, index) => {
    const original = sources[index];
    if (!original) return;
    const value =
      original instanceof HTMLSelectElement
        ? original.selectedOptions[0]?.textContent ?? original.value
        : original.value;
    const text = document.createElement('span');
    text.textContent = value;
    field.replaceWith(text);
  });

  clone.classList.add(SHEET_CLASS);
  clone.setAttribute('data-print-sheet', '');
  return clone;
}

/** A4 printable width in CSS pixels, matching the `@page` margins we inject. */
function printableWidthPx(landscape: boolean): number {
  const widthMm = landscape ? 297 - 20 : 210 - 28;
  // One pixel of slack so a rounding in the print engine cannot clip the edge.
  return Math.floor((widthMm * 96) / 25.4) - 1;
}

/**
 * Widest rendered content in a sheet. A fixed-width chart overflows its
 * clipped parents, so the widest descendant is the paper width the sheet needs.
 */
function contentWidthPx(el: HTMLElement): number {
  let width = el.scrollWidth;
  el.querySelectorAll<HTMLElement>('*').forEach((node) => {
    if (node.scrollWidth > width) width = node.scrollWidth;
  });
  return width;
}

/**
 * Scale-to-fit for a sheet wider than the paper (Gantt at day/week zoom).
 * `zoom` is used rather than `transform` because it reflows: the clone keeps
 * normal page flow, so a tall chart still paginates, and pinning the clone's
 * width to its own content width makes the whole chart map onto the printable
 * box instead of being clipped at the paper edge. The transform reset for every
 * other sheet is untouched — this is a print-only rule on the Gantt clone.
 */
function applyWidthFit(sheet: HTMLElement, source: HTMLElement, landscape: boolean): void {
  const width = contentWidthPx(source);
  const printable = printableWidthPx(landscape);
  const scale = width > 0 && width > printable ? printable / width : 1;
  sheet.setAttribute('data-print-fit', 'width');
  sheet.style.setProperty('--print-fit-scale', scale.toFixed(4));
  // Only pin the width when a shrink is needed; otherwise `width: 100%` stays.
  if (scale < 1) sheet.style.setProperty('--print-content-width', `${Math.floor(width)}px`);
}

/**
 * `@page` cannot be switched by a class, so the page geometry is injected as
 * its own (last) stylesheet for the duration of one print. A plain Ctrl+P that
 * bypasses this pipeline falls back to the A4 portrait rule in index.css.
 */
function applyPageStyle(landscape: boolean): void {
  document.getElementById(PAGE_STYLE_ID)?.remove();
  const style = document.createElement('style');
  style.id = PAGE_STYLE_ID;
  style.textContent = landscape
    ? '@page { size: A4 landscape; margin: 10mm; }'
    : '@page { size: A4 portrait; margin: 14mm; }';
  document.head.appendChild(style);
}

function teardown(): void {
  window.removeEventListener('afterprint', teardown);
  if (cleanupTimer) {
    clearTimeout(cleanupTimer);
    cleanupTimer = null;
  }
  document.getElementById(ROOT_ID)?.replaceChildren();
  document.getElementById(PAGE_STYLE_ID)?.remove();
  document.documentElement.classList.remove(LANDSCAPE_CLASS, PAGE_CLASS);
  if (previousTitle) {
    document.title = previousTitle;
    previousTitle = '';
  }
  inFlight = false;
}

/** Two frames: let the clone lay out (and the letterhead logo decode) first. */
function nextPaint(): Promise<void> {
  const raf =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number;
  return new Promise((resolve) => raf(() => raf(() => resolve())));
}

async function sendToPrinter(): Promise<void> {
  if (isDesktopApp()) {
    try {
      // macOS: our own Tauri command calls straight into the webview's native
      // print operation — window.print() is a silent no-op in some WKWebView
      // builds. Windows and Linux have no such native operation, so the
      // command answers false and the webview's own dialog is used.
      const native = await printWindowNative();
      if (native) return;
    } catch (error) {
      // Older build without the command: use the webview's own dialog.
      console.warn('Native print unavailable; falling back to window.print().', error);
    }
  }
  window.print();
}

/**
 * Print one element exactly as it is shown. Resolves true when the dialog was
 * opened, false when there was nothing to print or the transport failed (the
 * failure is also shown to the user).
 */
export async function printSheet(
  el: HTMLElement | null | undefined,
  options: PrintOptions = {}
): Promise<boolean> {
  if (typeof document === 'undefined') return false;
  if (inFlight) {
    // Double-click while the dialog is open (the normal case): ignore it. A
    // dialog that never fired afterprint is stale, so clear it and print.
    if (Date.now() - startedAt < IN_FLIGHT_MS) return false;
    teardown();
  }
  if (!el) {
    notify('Nothing to print yet — open the document first.', 'error');
    return false;
  }
  inFlight = true;
  startedAt = Date.now();
  try {
    const root = printRoot();
    root.replaceChildren(cloneSheet(el));
    // Measured from the live sheet (the print root is display:none until the
    // print media applies, so it cannot be measured while preparing).
    if (options.fitWidth) applyWidthFit(root.firstElementChild as HTMLElement, el, Boolean(options.landscape));

    if (!previousTitle) previousTitle = document.title;
    if (options.title) {
      const safe = options.title.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
      if (safe) document.title = safe;
    }
    document.documentElement.classList.add(PAGE_CLASS);
    document.documentElement.classList.toggle(LANDSCAPE_CLASS, Boolean(options.landscape));
    applyPageStyle(Boolean(options.landscape));
    window.addEventListener('afterprint', teardown);

    await nextPaint();
    await sendToPrinter();
    cleanupTimer = setTimeout(teardown, CLEANUP_MS);
    return true;
  } catch (error) {
    teardown();
    notify(
      `Could not print: ${error instanceof Error ? error.message : String(error)}. ` +
        'Use the app’s Print button again, or print to PDF from the same dialog.',
      'error'
    );
    return false;
  }
}

/**
 * Print the sheet the current page registered (Cmd+P / the ledger PDF button).
 * A page that registered nothing still prints: its `main` content is used, so
 * the action never does nothing.
 */
export async function printCurrentTarget(options: PrintOptions = {}): Promise<boolean> {
  const target = currentPrintTarget();
  if (target) {
    return printSheet(target.el, {
      title: target.title,
      landscape: target.landscape,
      fitWidth: target.fitWidth,
      ...options,
    });
  }
  const main = document.querySelector<HTMLElement>('main');
  return printSheet(main, { title: document.title, ...options });
}
