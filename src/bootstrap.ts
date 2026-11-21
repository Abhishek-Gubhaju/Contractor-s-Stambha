// Pre-paint bootstrap.
//
// This used to be an inline <script> in index.html. The desktop app now sends a
// strict CSP (`script-src 'self'`), which blocks inline script, so the same
// logic is bundled here and imported first from main.tsx.

type Theme = 'light' | 'dark';

function applyThemeToDOM(theme: Theme) {
  document.documentElement.classList.remove('light', 'dark');
  document.documentElement.classList.add(theme);
  document.documentElement.setAttribute('data-theme', theme);
}

const isInIframe = window.self !== window.top;

if (isInIframe) {
  // Previewed inside a sandbox: the parent pushes the theme.
  window.addEventListener('message', (event) => {
    if (event.data && typeof event.data.theme === 'string') {
      const theme = event.data.theme;
      if (theme === 'light' || theme === 'dark') applyThemeToDOM(theme);
    }
  });
} else {
  // Standalone: honour the saved preference before the first paint.
  let saved: string | null = null;
  try {
    saved = localStorage.getItem('darkMode');
  } catch {
    saved = null;
  }
  applyThemeToDOM(saved === 'true' ? 'dark' : 'light');
}

// Runtime-error reporting for the sandboxed preview. Harmless in the desktop
// app (no parent frame), where it simply never fires.
if (isInIframe) {
  const reported: Record<string, boolean> = {};
  window.addEventListener('error', (event) => {
    if (!event || !event.message) return; // resource-load errors carry no message
    const key = `${event.message}|${event.filename || ''}|${event.lineno || 0}`;
    if (reported[key]) return; // report each error once, never flood a render loop
    reported[key] = true;
    try {
      window.parent.postMessage(
        {
          type: 'sandbox-runtime-error',
          payload: {
            message: String(event.message).slice(0, 500),
            filename: event.filename || '',
            lineno: event.lineno || 0,
            colno: event.colno || 0,
            stack: event.error && event.error.stack ? String(event.error.stack).slice(0, 2000) : '',
          },
        },
        '*'
      );
    } catch {
      /* reporting must never break the page */
    }
  });
}

export {};
