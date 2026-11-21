import { useEffect, useRef } from 'react';
import { registerPrintTarget, type PrintTarget } from '../services/print/printService';

/**
 * Mark one element as "the sheet this page prints" and get its ref. The native
 * File → Print menu (Cmd+P) and page-level PDF buttons print whatever target is
 * registered, so every page prints its own document instead of app chrome.
 */
export function usePrintTarget<T extends HTMLElement = HTMLDivElement>(
  options: Omit<PrintTarget, 'el'> = {}
) {
  const ref = useRef<T | null>(null);
  const { title, landscape, fitWidth } = options;
  useEffect(
    () => registerPrintTarget(() => ({ el: ref.current, title, landscape, fitWidth })),
    [title, landscape, fitWidth]
  );
  return ref;
}
