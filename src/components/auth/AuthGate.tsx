// ============================================================================
// AuthGate — decides what the app shows before any data is visible.
//
//   no accounts           → first-run setup
//   usable session        → the app, bound to THAT account's data
//   locked session        → passcode screen (still signed in)
//   remembered account    → passcode sign-in for the last account used here,
//                           with the password always one tap away
//
// Data isolation is set up here, at the single point where identity becomes
// known: the storage namespace is switched before any child renders, so every
// existing module reads the signed-in account's keys and nothing else.
// ============================================================================
import { useEffect, useMemo, useState } from 'react';
import LoginPage from '../../pages/auth/LoginPage';
import {
  AUTH_EVENT,
  IDLE_MINUTES,
  SESSION_KEY,
  activeUser,
  hasUsers,
  lockedUser,
  rememberedUser,
  sessionState,
  touchSession,
  type AuthUser,
} from '../../services/auth/authService';
import { expireSession } from '../../services/auth/signOutFlow';
import { adoptLegacyData, setStorageNamespace } from '../../services/storage/userStorage';

type Mode = 'setup' | 'login' | 'locked' | 'ready';

function currentMode(): Mode {
  if (!hasUsers()) return 'setup';
  const state = sessionState();
  if (state === 'active') return 'ready';
  if (state === 'locked') return 'locked';
  return 'login';
}

/** Binds storage to one account before its screens mount, then mounts them. */
function ActiveSession({ user, children }: { user: AuthUser; children: React.ReactNode }) {
  useMemo(() => {
    setStorageNamespace(user.id);
    // Pre-account data belongs to the first account that signs in, once.
    adoptLegacyData(user.id);
  }, [user.id]);
  return <div key={user.id}>{children}</div>;
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<Mode>(currentMode);
  const [notice, setNotice] = useState('');

  // Any session change (sign-in, lock, sign-out, another tab) re-evaluates.
  useEffect(() => {
    const sync = () => setMode(currentMode());
    window.addEventListener(AUTH_EVENT, sync);
    const onStorage = (e: StorageEvent) => {
      if (!e.key || e.key === SESSION_KEY) sync();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(AUTH_EVENT, sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  // Signed out → no account's data may stay addressable.
  useEffect(() => {
    if (mode !== 'ready') setStorageNamespace(null);
  }, [mode]);

  // Idle expiry: the session is gone, so ask for the password again.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (sessionState() === 'expired') {
        // Silent best-effort backup first; nobody is here to answer a dialog.
        void expireSession();
        setMode(hasUsers() ? 'login' : 'setup');
        setNotice(`Signed out after ${IDLE_MINUTES} minutes of inactivity.`);
      }
    }, 20_000);
    return () => window.clearInterval(timer);
  }, []);

  // Real activity keeps an active session alive; a throttled touch is enough.
  useEffect(() => {
    let last = 0;
    const activity = () => {
      const now = Date.now();
      if (now - last < 15_000) return;
      last = now;
      touchSession();
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const event of events) window.addEventListener(event, activity, { passive: true });
    return () => {
      for (const event of events) window.removeEventListener(event, activity);
    };
  }, []);

  if (mode === 'ready') {
    const user = activeUser();
    if (user) return <ActiveSession user={user}>{children}</ActiveSession>;
  }

  const locked = mode === 'locked' ? lockedUser() : null;
  const remembered = mode === 'login' ? rememberedUser() : null;

  return (
    <LoginPage
      mode={mode === 'ready' ? 'login' : mode}
      signedInName={locked?.displayName}
      notice={notice}
      remembered={
        remembered
          ? {
              id: remembered.id,
              username: remembered.username,
              name: remembered.displayName,
              hasPasscode: !!remembered.passcode,
            }
          : null
      }
      onAuthenticated={() => {
        setNotice('');
        setMode('ready');
      }}
    />
  );
}
