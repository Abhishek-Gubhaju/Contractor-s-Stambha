// @vitest-environment jsdom
// Recovery is the door that exists when the password is gone. It must be hard
// to guess, impossible to read back, single-use per attempt and must never
// touch another account's data.
import { webcrypto } from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  SIGNED_OUT_KEY,
  USERS_KEY,
  createAccount,
  createUser,
  loadUsers,
  authenticate,
  recoveryChallenge,
  verifyRecovery,
  resetPasswordWithRecovery,
  rotateRecoveryKey,
  setRecoveryQuestions,
  signOut,
  signedOutAt,
  startSession,
  loadAuthLog,
  publicUsers,
} from './authService';
import {
  RECOVERY_MAX_FAILURES,
  RECOVERY_TICKET_KEY,
  answerProblem,
  formatRecoveryKey,
  generateRecoveryKey,
  normalizeAnswer,
  normalizeRecoveryKey,
  recoveryKeyProblem,
} from './recovery';

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

const PW = 'Example#2026';
const NEW_PW = 'Downtown#2026x';
const ANSWERS = [
  { questionId: 'birth-city', answer: 'Kathmandu' },
  { questionId: 'first-school', answer: 'Example School' },
  { questionId: 'first-employer', answer: 'Example Constructions' },
];

const register = () =>
  createAccount({
    username: 'alex',
    password: PW,
    displayName: 'Alex G.',
    recovery: { answers: ANSWERS },
  });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('recovery primitives', () => {
  it('normalises answers so case and spacing do not matter', () => {
    expect(normalizeAnswer('  Kathmandu   Valley ')).toBe('kathmandu valley');
    // Punctuation is not something people remember reliably.
    expect(normalizeAnswer('Example School')).toBe('example school');
    expect(normalizeAnswer('Example Constructions (P) Ltd.')).toBe('example constructions p ltd');
    expect(answerProblem(' ')).toMatch(/two characters/);
  });

  it('makes readable, typo-tolerant recovery keys', () => {
    const key = generateRecoveryKey();
    expect(key).toMatch(/^([A-Z2-9]{4}-){4}[A-Z2-9]{4}$/);
    expect(recoveryKeyProblem(key)).toBeNull();
    // Lower case and missing dashes are forgiven.
    expect(normalizeRecoveryKey(key.toLowerCase().replace(/-/g, ''))).toBe(normalizeRecoveryKey(key));
    expect(formatRecoveryKey('abcd2345efgh6789jkmn')).toBe('ABCD-2345-EFGH-6789-JKMN');
  });
});

describe('account creation with recovery', () => {
  it('stores only hashes and returns the key exactly once', async () => {
    const { user, recoveryKey } = await register();
    expect(user.recovery?.questions).toHaveLength(3);
    expect(user.recovery?.key).not.toBeNull();
    expect(recoveryKeyProblem(recoveryKey)).toBeNull();

    const dump = JSON.stringify(localStorage.getItem(USERS_KEY));
    expect(dump).not.toContain(PW);
    expect(dump).not.toContain('Kathmandu');
    expect(dump).not.toContain(recoveryKey.replace(/-/g, ''));
    expect(loadUsers()[0].recovery?.questions[0].answer.algo).toBe('pbkdf2-sha256');
  });

  it('keys accounts written before recovery existed', async () => {
    // A legacy record without the new fields must still load and behave.
    localStorage.setItem(
      USERS_KEY,
      JSON.stringify([
        {
          id: 'usr-old',
          username: 'old',
          displayName: 'Old Account',
          admin: true,
          password: { algo: 'pbkdf2-sha256', iterations: 1000, salt: 'AAAA', hash: 'a'.repeat(64) },
          passcode: null,
          createdAt: '2020-01-01',
          updatedAt: '2020-01-01',
          lastLoginAt: null,
          failedAttempts: 0,
          lockedUntil: null,
          passcodeFails: 0,
          passcodeLockedUntil: null,
        },
      ])
    );
    const user = loadUsers()[0];
    expect(user.recovery).toBeNull();
    expect(user.recoveryFails).toBe(0);
    expect(recoveryChallenge('old').ok).toBe(false);
    expect(publicUsers()[0].hasRecovery).toBe(false);
  });
});

describe('recovering with questions', () => {
  it('needs two of the three answers and issues a working ticket', async () => {
    const { user } = await register();
    const challenge = recoveryChallenge('ALEX');
    expect(challenge.ok).toBe(true);
    expect(challenge.questions?.map((q) => q.id)).toEqual(ANSWERS.map((a) => a.questionId));
    expect(challenge.hasKey).toBe(true);

    const oneRight = await verifyRecovery(user.id, { answers: ['Kathmandu', 'wrong', 'wrong'] });
    expect(oneRight.ok).toBe(false);
    expect(oneRight.ok === false && oneRight.matched).toBe(1);

    const twoRight = await verifyRecovery(user.id, { answers: [' kathmandu ', 'EXAMPLE SCHOOL', 'nope'] });
    expect(twoRight.ok).toBe(true);
    if (!twoRight.ok) return;
    expect(sessionStorage.getItem(RECOVERY_TICKET_KEY)).not.toBeNull();

    const reset = await resetPasswordWithRecovery(twoRight.ticket.token, NEW_PW);
    expect(reset.ok).toBe(true);
    expect((await authenticate('alex', PW)).ok).toBe(false);
    expect((await authenticate('alex', NEW_PW)).ok).toBe(true);
    // The ticket is consumed and cannot be replayed.
    expect(sessionStorage.getItem(RECOVERY_TICKET_KEY)).toBeNull();
    expect((await resetPasswordWithRecovery(twoRight.ticket.token, 'Another#2026x')).ok).toBe(false);
    expect(loadAuthLog().some((e) => e.type === 'recovery-used')).toBe(true);
  });

  it('locks recovery after repeated wrong answers', async () => {
    const { user } = await register();
    let last: Awaited<ReturnType<typeof verifyRecovery>> | null = null;
    for (let i = 0; i < RECOVERY_MAX_FAILURES; i++) last = await verifyRecovery(user.id, { answers: ['a', 'b', 'c'] });
    expect(last && last.ok).toBe(false);
    expect(last && !last.ok && last.reason).toBe('locked');
    // Even correct answers wait for the cooldown.
    const blocked = await verifyRecovery(user.id, { answers: ['Kathmandu', 'Example School', 'Example Constructions'] });
    expect(blocked.ok).toBe(false);
    expect(recoveryChallenge('alex').reason).toBe('locked');
  });
});

describe('recovering with the key', () => {
  it('accepts the generated key and rejects a wrong one', async () => {
    const { user, recoveryKey } = await register();
    const wrong = await verifyRecovery(user.id, { key: generateRecoveryKey() });
    expect(wrong.ok).toBe(false);

    const good = await verifyRecovery(user.id, { key: recoveryKey.toLowerCase() });
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect((await resetPasswordWithRecovery(good.ticket.token, NEW_PW)).ok).toBe(true);
  });

  it('rotating a key stops the old one working immediately', async () => {
    const { user, recoveryKey } = await register();
    const fresh = await rotateRecoveryKey(user.id, PW);
    expect(fresh).not.toBe(recoveryKey);
    expect((await verifyRecovery(user.id, { key: recoveryKey })).ok).toBe(false);
    expect((await verifyRecovery(user.id, { key: fresh })).ok).toBe(true);
  });

  it('refuses to replace questions or keys without the password', async () => {
    const { user } = await register();
    await expect(setRecoveryQuestions(user.id, 'WrongPassword1', { answers: ANSWERS })).rejects.toThrow(/password/i);
    await expect(rotateRecoveryKey(user.id, 'WrongPassword1')).rejects.toThrow(/password/i);
  });

});

describe('edge cases', () => {
  it('expires a recovery ticket instead of letting it linger', async () => {
    const { user } = await register();
    const verified = await verifyRecovery(user.id, { answers: ['Kathmandu', 'Example School', 'x'] });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    const raw = JSON.parse(sessionStorage.getItem(RECOVERY_TICKET_KEY)!);
    sessionStorage.setItem(RECOVERY_TICKET_KEY, JSON.stringify({ ...raw, expires_at: Date.now() - 1000 }));
    const reset = await resetPasswordWithRecovery(verified.ticket.token, NEW_PW);
    expect(reset.ok).toBe(false);
    expect(reset.reason).toBe('ticket');
  });

  it('keeps recovery off an account that never set it up', async () => {
    const plain = await createUser({ username: 'site', password: PW });
    expect(recoveryChallenge('site').ok).toBe(false);
    expect((await verifyRecovery(plain.id, { answers: ['a', 'b', 'c'] })).ok).toBe(false);
  });
});

describe('sign-out semantics', () => {
  it('marks an explicit sign-out so the passcode pad is not offered by default', async () => {
    const { user } = await register();
    startSession(user);
    expect(signedOutAt()).toBeNull();

    signOut('manual');
    expect(signedOutAt()).toBeTruthy();
    expect(localStorage.getItem(SIGNED_OUT_KEY)).toBeTruthy();

    startSession(user);
    expect(signedOutAt()).toBeNull();
  });

  it('does not mark an idle expiry as a deliberate sign-out', async () => {
    const { user } = await register();
    startSession(user);
    signOut('expired');
    expect(signedOutAt()).toBeNull();
  });
});
