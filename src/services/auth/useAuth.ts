// React binding for the auth session. The session is the source of truth in
// sessionStorage, so this hook just re-reads it whenever the service says
// something changed (or another tab does).
import { useEffect, useState } from 'react';
import {
  AUTH_EVENT,
  SESSION_KEY,
  activeUser,
  lockedUser,
  sessionState,
  signOut,
  lockSession,
  touchSession,
  type AuthUser,
  type SessionState,
} from './authService';

export interface AuthSnapshot {
  user: AuthUser | null; // signed in and usable
  locked: AuthUser | null; // signed in but locked, waiting for the passcode
  state: SessionState;
}

function read(): AuthSnapshot {
  return { user: activeUser(), locked: lockedUser(), state: sessionState() };
}

export function useAuth(): AuthSnapshot {
  const [snapshot, setSnapshot] = useState<AuthSnapshot>(read);

  useEffect(() => {
    const update = () => setSnapshot(read());
    window.addEventListener(AUTH_EVENT, update);
    window.addEventListener('storage', update);
    // Returning to the window after time away must re-check the idle clock.
    window.addEventListener('focus', update);
    const timer = window.setInterval(update, 30_000);
    return () => {
      window.removeEventListener(AUTH_EVENT, update);
      window.removeEventListener('storage', update);
      window.removeEventListener('focus', update);
      window.clearInterval(timer);
    };
  }, []);

  return snapshot;
}

export { signOut, lockSession, touchSession, SESSION_KEY };
