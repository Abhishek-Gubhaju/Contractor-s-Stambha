// @vitest-environment jsdom
// The delete guard must verify against the stored hash, log every attempt and
// back off like the sign-in screen does.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  MAX_FAILURES,
  deleteSecretKind,
  loadAuthLog,
  signOut,
  verifyDeleteSecret,
} from './authService';
import { seedSignedInUser, TEST_PASSCODE, TEST_PASSWORD } from '../../testUtils/seedAuth';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('delete guard', () => {
  it('verifies the passcode and logs the confirmation', async () => {
    await seedSignedInUser();
    expect(deleteSecretKind()).toBe('passcode');

    const result = await verifyDeleteSecret(TEST_PASSCODE);
    expect(result).toMatchObject({ ok: true, requires: 'passcode' });
    expect(loadAuthLog().some((e) => e.type === 'delete-confirmed')).toBe(true);
  });

  it('accepts the account password when a passcode exists', async () => {
    await seedSignedInUser();
    expect((await verifyDeleteSecret(TEST_PASSWORD)).ok).toBe(true);
  });

  it('rejects a wrong secret and records the denial', async () => {
    await seedSignedInUser();
    const result = await verifyDeleteSecret('999999');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid');
    expect(loadAuthLog().some((e) => e.type === 'delete-denied')).toBe(true);
  });

  it(`locks after ${MAX_FAILURES} wrong attempts`, async () => {
    await seedSignedInUser();
    for (let i = 0; i < MAX_FAILURES; i++) {
      expect((await verifyDeleteSecret('000000')).ok).toBe(false);
    }
    const locked = await verifyDeleteSecret(TEST_PASSCODE);
    expect(locked.ok).toBe(false);
    expect(locked.reason).toBe('locked');
    expect(locked.retryAfterMs).toBeGreaterThan(0);

    const log = loadAuthLog();
    expect(log.some((e) => e.type === 'lockout')).toBe(true);
  });

  it('asks for the password when the account has no passcode', async () => {
    await seedSignedInUser({ passcode: null });
    expect(deleteSecretKind()).toBe('password');
    expect((await verifyDeleteSecret(TEST_PASSWORD)).ok).toBe(true);
  });

  it('never verifies without a signed-in session', async () => {
    await seedSignedInUser();
    signOut();
    const result = await verifyDeleteSecret(TEST_PASSCODE);
    expect(result).toMatchObject({ ok: false, reason: 'no-session' });
  });
});
