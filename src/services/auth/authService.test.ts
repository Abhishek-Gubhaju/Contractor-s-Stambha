// @vitest-environment jsdom
// Sign-in must be safe to fail: no plaintext secrets, no account enumeration,
// backoff after repeated guesses, a session that really expires, and a passcode
// that only unlocks a session that already exists.
import { webcrypto } from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  LOG_KEY,
  SESSION_KEY,
  USERS_KEY,
  MAX_FAILURES,
  authenticate,
  changeOwnPassword,
  createUser,
  findUser,
  hasUsers,
  loadAuthLog,
  loadUsers,
  lockSession,
  lockedUser,
  activeUser,
  passcodeProblem,
  passwordProblems,
  publicUsers,
  removeUser,
  rememberedUser,
  authenticateWithPasscode,
  LAST_USER_KEY,
  sessionState,
  setPasscode,
  signOut,
  startSession,
  unlockSession,
  unlockUser,
  setPassword,
} from './authService';

// jsdom ships getRandomValues but not SubtleCrypto; Node has both.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

const PW = 'Example#2026';

const makeAdmin = (overrides: Partial<{ username: string; password: string; passcode: string | null }> = {}) =>
  createUser({
    username: overrides.username ?? 'alex',
    password: overrides.password ?? PW,
    displayName: 'Alex G.',
    passcode: overrides.passcode === undefined ? '482915' : overrides.passcode,
  });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('89. account creation and password policy', () => {
  it('makes the first account an administrator and normalises the username', async () => {
    const user = await makeAdmin({ username: '  Alex.G ' });
    expect(user.username).toBe('alex.g');
    expect(user.admin).toBe(true);
    expect(hasUsers()).toBe(true);
    expect(findUser('ALEX.G')?.id).toBe(user.id);
  });

  it('refuses weak or duplicated credentials', async () => {
    await makeAdmin();
    await expect(makeAdmin({ username: 'alex' })).rejects.toThrow(/already taken/i);
    await expect(createUser({ username: 'asha', password: 'password' })).rejects.toThrow();
    await expect(createUser({ username: 'asha', password: 'short1' })).rejects.toThrow(/at least 10/i);
    await expect(createUser({ username: 'asharam', password: 'asharam12345' })).rejects.toThrow(/username/i);
    await expect(createUser({ username: 'asha', password: 'Site-Office-2026', passcode: '111111' })).rejects.toThrow(/repeat/i);
  });

  it('validates policy without rejecting a genuinely strong password', () => {
    expect(passwordProblems(PW, 'alex')).toEqual([]);
    expect(passcodeProblem('482915')).toBeNull();
    expect(passcodeProblem('1234')).toMatch(/6 digits/);
    expect(passcodeProblem('123456')).toMatch(/too easy/);
  });

  it('never writes a plaintext password or passcode to storage', async () => {
    await makeAdmin();
    const dump = JSON.stringify(localStorage.getItem(USERS_KEY)) + JSON.stringify(localStorage.getItem(LOG_KEY) ?? '');
    expect(dump).not.toContain(PW);
    expect(dump).not.toContain('482915');
    expect(loadUsers()[0].password.algo).toBe('pbkdf2-sha256');
  });
});

describe('90. sign-in', () => {
  it('accepts the right password and rejects the wrong one with the same message', async () => {
    const user = await makeAdmin();
    const good = await authenticate('alex', PW);
    expect(good.ok).toBe(true);
    expect(good.user?.id).toBe(user.id);
    expect(good.user?.lastLoginAt).toBeTruthy();

    const bad = await authenticate('alex', 'WrongPassword123');
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe('invalid');

    const ghost = await authenticate('nobody', 'WrongPassword123');
    expect(ghost.reason).toBe('invalid'); // indistinguishable from a wrong password
  });

  it('backs off after repeated failures instead of allowing endless guesses', async () => {
    await makeAdmin();
    let last: Awaited<ReturnType<typeof authenticate>> | null = null;
    for (let i = 0; i < MAX_FAILURES; i++) last = await authenticate('alex', 'WrongPassword123');

    expect(last!.ok).toBe(false);
    expect(last!.reason).toBe('locked');
    expect(last!.retryAfterMs).toBeGreaterThan(0);
    // even the correct password is refused while locked
    const blocked = await authenticate('alex', PW);
    expect(blocked.reason).toBe('locked');
  });

  it('lets an administrator clear a lockout', async () => {
    const admin = await makeAdmin();
    for (let i = 0; i < MAX_FAILURES; i++) await authenticate('alex', 'WrongPassword123');
    expect(publicUsers()[0].locked).toBe(true);
    unlockUser(admin.id, admin.id);
    expect(publicUsers()[0].locked).toBe(false);
    expect((await authenticate('alex', PW)).ok).toBe(true);
  });
});

describe('91. sessions', () => {
  it('starts active, locks without ending, and unlocks with the passcode', async () => {
    const user = await makeAdmin();
    startSession(user);
    expect(sessionState()).toBe('active');
    expect(activeUser()?.id).toBe(user.id);

    lockSession();
    expect(sessionState()).toBe('locked');
    expect(activeUser()).toBeNull(); // not usable while locked
    expect(lockedUser()?.id).toBe(user.id);

    const wrong = await unlockSession('000001');
    expect(wrong.ok).toBe(false);
    expect(sessionState()).toBe('locked');

    const right = await unlockSession('482915');
    expect(right.ok).toBe(true);
    expect(sessionState()).toBe('active');
  });

  it('falls back to the password for unlock and for accounts without a passcode', async () => {
    const user = await makeAdmin({ passcode: null });
    startSession(user);
    lockSession();
    expect((await unlockSession(PW)).ok).toBe(true);
    expect(sessionState()).toBe('active');
  });

  it('expires after the idle window and after sign-out, and refuses to unlock a dead session', async () => {
    const user = await makeAdmin();
    startSession(user);
    lockSession();

    const raw = JSON.parse(sessionStorage.getItem(SESSION_KEY)!);
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ ...raw, last_seen: Date.now() - 16 * 60_000 }));
    expect(sessionState()).toBe('expired');
    expect((await unlockSession('482915')).ok).toBe(false); // an expired session is gone

    startSession(user);
    signOut();
    expect(sessionState()).toBe('none');
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('limits wrong passcodes instead of allowing infinite tries', async () => {
    const user = await makeAdmin();
    startSession(user);
    lockSession();
    let last: Awaited<ReturnType<typeof unlockSession>> | null = null;
    for (let i = 0; i < MAX_FAILURES; i++) last = await unlockSession('000001');
    expect(last!.ok).toBe(false);
    expect(last!.reason).toBe('locked-down');
    expect(last!.retryAfterMs).toBeGreaterThan(0);
    // the real passcode is refused during the cooldown, the password still works
    expect((await unlockSession('482915')).reason).toBe('locked-down');
    expect((await unlockSession(PW)).ok).toBe(true);
  });

  it('backs off wrong passwords on the lock screen just like sign-in', async () => {
    const user = await makeAdmin();
    startSession(user);
    lockSession();
    let last: Awaited<ReturnType<typeof unlockSession>> | null = null;
    for (let i = 0; i < MAX_FAILURES; i++) last = await unlockSession('NotThePassword#1');
    expect(last!.ok).toBe(false);
    expect(last!.reason).toBe('locked-down');
    expect(last!.retryAfterMs).toBeGreaterThan(0);
    // The real password waits out the cooldown too.
    expect((await unlockSession(PW)).reason).toBe('locked-down');
  });
});

describe('95. the remembered account and its passcode', () => {
  it('remembers who signed in and signs them back in with the passcode', async () => {
    const user = await makeAdmin();
    await authenticate('alex', PW);
    expect(rememberedUser()?.id).toBe(user.id);

    const ok = await authenticateWithPasscode(user.id, '482915');
    expect(ok.ok).toBe(true);
    expect(ok.user?.id).toBe(user.id);
    expect(ok.user?.lastLoginAt).toBeTruthy();
  });

  it('refuses a passcode for an account that has none, and after too many misses', async () => {
    const user = await makeAdmin({ passcode: null });
    expect((await authenticateWithPasscode(user.id, '482915')).ok).toBe(false);

    await setPasscode(user.id, '482915');
    let last: Awaited<ReturnType<typeof authenticateWithPasscode>> | null = null;
    for (let i = 0; i < MAX_FAILURES; i++) last = await authenticateWithPasscode(user.id, '111222');
    expect(last!.ok).toBe(false);
    expect(last!.reason).toBe('locked');
    expect(last!.retryAfterMs).toBeGreaterThan(0);
    // the right digits are refused during the cooldown; the password still works
    expect((await authenticateWithPasscode(user.id, '482915')).reason).toBe('locked');
    expect((await authenticate('alex', PW)).ok).toBe(true);
  });

  it('never leaks the passcode into storage and forgets a removed account', async () => {
    const admin = await makeAdmin();
    await authenticate('alex', PW);
    expect(localStorage.getItem(LAST_USER_KEY)).toBe(admin.id);
    expect(JSON.stringify(localStorage.getItem(USERS_KEY))).not.toContain('482915');

    const staff = await createUser({ username: 'asha', password: 'Site-Office-2026' });
    await authenticate('asha', 'Site-Office-2026');
    expect(rememberedUser()?.id).toBe(staff.id);
    removeUser(staff.id, admin.id);
    expect(rememberedUser()).toBeNull();
  });
});

describe('92. account administration', () => {
  it('requires the current password to change it', async () => {
    const user = await makeAdmin();
    await expect(changeOwnPassword(user.id, 'NotMyPassword1', 'Downtown#2026')).rejects.toThrow(/current password/i);
    await changeOwnPassword(user.id, PW, 'Downtown#2026');
    expect((await authenticate('alex', PW)).ok).toBe(false);
    expect((await authenticate('alex', 'Downtown#2026')).ok).toBe(true);
  });

  it('keeps one administrator and never removes the signed-in account', async () => {
    const admin = await makeAdmin();
    const staff = await createUser({ username: 'asha', password: 'Site-Office-2026', displayName: 'Asha' });
    expect(staff.admin).toBe(false);

    expect(() => removeUser(admin.id, admin.id)).toThrow(/signed in/i);
    expect(() => removeUser(admin.id, staff.id)).toThrow(/administrator/i);
    removeUser(staff.id, admin.id);
    expect(publicUsers()).toHaveLength(1);
  });

  it('lets an administrator reset another password but not a standard user', async () => {
    const admin = await makeAdmin();
    const staff = await createUser({ username: 'asha', password: 'Site-Office-2026' });
    await expect(setPassword(admin.id, 'Downtown#2026', staff.id)).rejects.toThrow(/administrator/i);
    await setPassword(staff.id, 'Downtown#2026', admin.id);
    expect((await authenticate('asha', 'Downtown#2026')).ok).toBe(true);
  });

  it('records an audit trail with no secrets in it', async () => {
    const user = await makeAdmin();
    await authenticate('alex', 'WrongPassword123');
    await authenticate('alex', PW);
    startSession(user);
    lockSession();
    await unlockSession('482915');
    setPasscode(user.id, null);

    const log = loadAuthLog();
    expect(log.map((e) => e.type)).toContain('login-failed');
    expect(log.map((e) => e.type)).toContain('unlocked');
    const dump = JSON.stringify(log);
    expect(dump).not.toContain(PW);
    expect(dump).not.toContain('482915');
  });
});
