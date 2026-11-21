// ============================================================================
// userStorage — each account gets its own data, guaranteed at the storage layer.
//
// The app has ~120 places that read and write localStorage. Rather than teach
// every one of them about users (and miss a few), the boundary itself is
// renamed: once someone signs in, `window.localStorage` becomes a shim that maps
//
//     contractoros_boq::PRJ-001
//   → contractoros_u:usr-abc::contractoros_boq::PRJ-001
//
// So every existing module — BOQ, ledger, billing, inventory, statements,
// backups — keeps working untouched, and two accounts physically cannot read
// each other's keys. Keys that are not app data (theme, and the credentials
// themselves) pass straight through, so the login screen still works before
// anyone is signed in.
//
// The shim also hides other users' keys from `length`/`key(i)`, because the
// backup snapshot walks the store that way; a backup must never contain another
// person's books.
// ============================================================================
import { isSecretHash } from '../auth/crypto';

const APP_PREFIX = 'contractoros_';
const AUTH_PREFIX = 'contractoros_auth_';
export const USER_PREFIX = 'contractoros_u:';
export const LEGACY_OWNER_KEY = 'contractoros_legacy_owner';
export const USER_STORAGE_EVENT = 'contractoros:user-storage-changed';

/** Notified after every successful write through the shim. */
export type StorageWriteListener = (key: string, value: string | null) => void;

let activeUserId: string | null = null;
let installed = false;
let real: Storage | null = null;
let writeListener: StorageWriteListener | null = null;

/** The durable mirror hooks in here, so every save is seen without touching call sites. */
export function setStorageWriteListener(listener: StorageWriteListener | null): void {
  writeListener = listener;
}

function realStorage(): Storage {
  if (real) return real;
  return window.localStorage;
}

/** The physical key a logical key lives under for one user. */
export function userKeyFor(userId: string | null, key: string): string {
  const k = String(key);
  if (!userId) return k;
  if (!k.startsWith(APP_PREFIX) || k.startsWith(AUTH_PREFIX)) return k;
  if (k.startsWith(USER_PREFIX)) return k;
  return `${USER_PREFIX}${userId}::${k}`;
}

function namespacePrefix(userId: string): string {
  return `${USER_PREFIX}${userId}::`;
}

/** Logical keys this user can see: their own app data plus non-app preferences. */
function visibleKeys(store: Storage, userId: string | null): string[] {
  const out: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const physical = store.key(i);
    if (!physical) continue;
    if (userId) {
      const prefix = namespacePrefix(userId);
      if (physical.startsWith(prefix)) {
        out.push(physical.slice(prefix.length));
      } else if (!physical.startsWith(APP_PREFIX)) {
        out.push(physical); // darkMode and friends: not app data
      }
      // another user's data, and un-adopted legacy data, stay hidden
    } else if (!physical.startsWith(USER_PREFIX)) {
      out.push(physical);
    }
  }
  return out;
}

/** Every physical key belonging to one user's namespace. */
export function userKeys(userId: string): string[] {
  const store = realStorage();
  const prefix = namespacePrefix(userId);
  const out: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const physical = store.key(i);
    if (physical && physical.startsWith(prefix)) out.push(physical);
  }
  return out;
}

export function storageNamespace(): string | null {
  return activeUserId;
}

/**
 * Point the app at one user's data. Called when a session becomes usable, and
 * nulled on sign-out so the login screen never sees anyone's books.
 */
export function setStorageNamespace(userId: string | null): void {
  const next = userId || null;
  if (next === activeUserId) return;
  activeUserId = next;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(USER_STORAGE_EVENT, { detail: { userId: next } }));
  }
}

export function installUserStorage(): void {
  if (typeof window === 'undefined' || installed) return;
  const store = window.localStorage; // capture whatever is live (real or memory fallback)
  real = store;

  const shim: Storage = {
    get length() {
      return visibleKeys(store, activeUserId).length;
    },
    key(index: number) {
      return visibleKeys(store, activeUserId)[index] ?? null;
    },
    getItem(key: string) {
      return store.getItem(userKeyFor(activeUserId, key));
    },
    setItem(key: string, value: string) {
      store.setItem(userKeyFor(activeUserId, key), String(value));
      writeListener?.(String(key), String(value));
    },
    removeItem(key: string) {
      store.removeItem(userKeyFor(activeUserId, key));
      writeListener?.(String(key), null);
    },
    clear() {
      // Only this account's app data. Never wipe preferences or other accounts.
      if (activeUserId) {
        for (const physical of userKeys(activeUserId)) store.removeItem(physical);
        writeListener?.('', null);
        return;
      }
      for (const physical of visibleKeys(store, null)) {
        if (physical.startsWith(APP_PREFIX) && !physical.startsWith(AUTH_PREFIX)) store.removeItem(physical);
      }
      writeListener?.('', null);
    },
  };

  Object.defineProperty(window, 'localStorage', { configurable: true, get: () => shim });
  installed = true;
}

/** True once the namespace shim owns localStorage (bootstrap calls install). */
export function userStorageInstalled(): boolean {
  return installed;
}

// ---------------------------------------------------------------------------
// Raw access for migration and administration (bypasses the namespace)
// ---------------------------------------------------------------------------

/** Every logical app key currently outside any user namespace. */
export function legacyAppKeys(): string[] {
  const store = realStorage();
  const out: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const physical = store.key(i);
    if (!physical) continue;
    if (physical.startsWith(APP_PREFIX) && !physical.startsWith(AUTH_PREFIX) && !physical.startsWith(USER_PREFIX)) {
      out.push(physical);
    }
  }
  return out;
}

export function legacyOwner(): string | null {
  try {
    return realStorage().getItem(LEGACY_OWNER_KEY);
  } catch {
    return null;
  }
}

/**
 * The data that existed before accounts did belongs to the FIRST account that
 * signs in, so upgrading an install does not look like data loss. It runs once:
 * the owner is recorded, and later accounts start empty. Originals are copied,
 * not moved, and stay hidden as the recovery copy.
 */
export function adoptLegacyData(userId: string): { adopted: number; alreadyOwned: boolean } {
  if (!userId) return { adopted: 0, alreadyOwned: false };
  const store = realStorage();
  const owner = legacyOwner();
  if (owner) return { adopted: 0, alreadyOwned: true };

  let adopted = 0;
  for (const physical of legacyAppKeys()) {
    const target = userKeyFor(userId, physical);
    if (store.getItem(target) !== null) continue;
    const value = store.getItem(physical);
    if (value === null) continue;
    store.setItem(target, value);
    adopted++;
  }
  try {
    store.setItem(LEGACY_OWNER_KEY, userId);
  } catch {
    /* marker is best-effort; worst case adoption is idempotent anyway */
  }
  return { adopted, alreadyOwned: false };
}

/** Remove every byte one account owns (used when an account is deleted). */
export function purgeUserData(userId: string): number {
  const store = realStorage();
  let removed = 0;
  for (const physical of userKeys(userId)) {
    store.removeItem(physical);
    removed++;
  }
  return removed;
}

/** Accounts that have data on this machine (for the admin view). */
export function usersWithData(): { userId: string; keys: number }[] {
  const store = realStorage();
  const counts = new Map<string, number>();
  for (let i = 0; i < store.length; i++) {
    const physical = store.key(i);
    if (!physical || !physical.startsWith(USER_PREFIX)) continue;
    const rest = physical.slice(USER_PREFIX.length);
    const sep = rest.indexOf('::');
    if (sep < 0) continue;
    const userId = rest.slice(0, sep);
    counts.set(userId, (counts.get(userId) || 0) + 1);
  }
  return [...counts.entries()].map(([userId, keys]) => ({ userId, keys })).sort((a, b) => a.userId.localeCompare(b.userId));
}

export { isSecretHash };
