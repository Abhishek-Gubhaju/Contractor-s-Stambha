// Which vault backend this context gets.
//
// desktop  → real files (Tauri)
// browser  → IndexedDB blobs
// memory   → neither is available (tests, locked-down webviews)
//
// The choice is made once and can be overridden by tests.
import { isDesktopApp } from '../backup/desktop';
import { browserVault } from './browserVault';
import { desktopVault } from './desktopVault';
import { memoryVault } from './memoryVault';
import type { VaultStorage } from './storageTypes';

let current: VaultStorage | null = null;

export function resolveVaultStorage(): VaultStorage {
  if (isDesktopApp()) return desktopVault;
  if (typeof indexedDB !== 'undefined') return browserVault;
  return memoryVault;
}

export function getVaultStorage(): VaultStorage {
  if (!current) current = resolveVaultStorage();
  return current;
}

/** Tests (and a deliberate fallback) can pin the backend. */
export function setVaultStorage(next: VaultStorage | null): void {
  current = next;
}

export function vaultModeLabel(mode: VaultStorage['mode']): string {
  if (mode === 'desktop') return 'Stored as real files on this computer';
  if (mode === 'browser') return 'Stored in this browser only';
  return 'Temporary session storage';
}
