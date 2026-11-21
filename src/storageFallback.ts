// Some browsers block localStorage inside embedded/third-party iframes (e.g. the
// Netlify deploy preview), where any access throws a SecurityError. Many parts
// of the app read localStorage directly, so an uncaught throw during render
// unmounts React and leaves a blank page. When storage is unavailable, swap in
// an in-memory Storage so the app still runs (data just won't persist).
function storageWorks(): boolean {
  try {
    const s = window.localStorage;
    const k = '__contractoros_probe__';
    s.setItem(k, '1');
    s.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

if (typeof window !== 'undefined' && !storageWorks()) {
  const data = new Map<string, string>();
  const memory: Storage = {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (k) => (data.has(String(k)) ? data.get(String(k))! : null),
    key: (i) => Array.from(data.keys())[i] ?? null,
    removeItem: (k) => { data.delete(String(k)); },
    setItem: (k, v) => { data.set(String(k), String(v)); },
  };
  try {
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => memory });
    console.warn('localStorage is unavailable; using in-memory storage for this session.');
  } catch (e) {
    console.warn('Unable to install localStorage fallback:', e);
  }
}

export {};
