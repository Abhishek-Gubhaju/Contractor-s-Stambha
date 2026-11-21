// ============================================================================
// authService — local sign-in for an offline desktop app.
//
// What this is: a device lock. It stops someone who picks up the machine from
// reading or posting to the books, it hashes every secret before it is stored,
// and it slows down guessing. What it is NOT: encryption at rest. The data
// still lives in the app's local storage and is readable by anyone with
// filesystem access to this machine. Real at-rest encryption would mean
// re-encrypting every store and every backup — a separate decision, not
// something to slip in beside a login screen.
//
// Design rules that keep it honest:
//   • passwords and PINs are only ever stored as PBKDF2 hashes (crypto.ts)
//   • a failed sign-in is reported as "invalid username or password" — the
//     same message whether the user exists or not
//   • repeated failures back off: 5th..∞ double from 30s, capped at 15 min
//   • the session lives in sessionStorage, so closing the app signs you out
//   • 15 min idle locks it, 12 h absolute limits it, manual lock keeps the
//     user so a 6-digit passcode can get back in
//   • credentials are never part of a backup: the backup manifest lists its
//     stores explicitly, and these keys are not on it
// ============================================================================
import {
  PASSWORD_ITERATIONS,
  PASSCODE_ITERATIONS,
  hashSecret,
  isSecretHash,
  randomToken,
  verifySecret,
  type SecretHash,
} from './crypto';
import {
  RECOVERY_ANSWER_THRESHOLD,
  RECOVERY_MAX_FAILURES,
  RECOVERY_QUESTION_COUNT,
  answerProblem,
  clearRecoveryTicket,
  generateRecoveryKey,
  hashAnswer,
  hashRecoveryKey,
  issueRecoveryTicket,
  normalizeRecoveryKey,
  questionLabel,
  readRecoveryTicket,
  recoveryKeyProblem,
  verifyAnswer,
  verifyRecoveryKey,
  type RecoveryTicket,
} from './recovery';

export const USERS_KEY = 'contractoros_auth_users';
export const LOG_KEY = 'contractoros_auth_log';
// Who signed in last on this computer. Only the username is remembered — the
// password is never stored, and the passcode still has to be proved.
export const LAST_USER_KEY = 'contractoros_auth_last_user';
export const SESSION_KEY = 'contractoros_auth_session';
// Set by an explicit sign-out, so the next screen asks for the PASSWORD rather
// than silently offering the remembered account's passcode pad.
export const SIGNED_OUT_KEY = 'contractoros_auth_signed_out';
export const AUTH_EVENT = 'contractoros:auth-changed';

export const PASSWORD_MIN = 10;
export const PASSCODE_LENGTH = 6;
export const MAX_FAILURES = 5;
export const IDLE_MINUTES = 15;
export const SESSION_HOURS = 12;
const LOG_LIMIT = 200;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface AuthUser {
  id: string;
  username: string; // normalised, the login key
  displayName: string;
  admin: boolean;
  password: SecretHash;
  passcode: SecretHash | null;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  failedAttempts: number;
  lockedUntil: number | null;
  passcodeFails: number;
  passcodeLockedUntil: number | null;
  /** Answers are salted PBKDF2 hashes; the recovery key is hashed too. */
  recovery: StoredRecovery | null;
  recoveryFails: number;
  recoveryLockedUntil: number | null;
}

export interface StoredRecoveryQuestion {
  question_id: string;
  answer: SecretHash;
}

export interface StoredRecovery {
  questions: StoredRecoveryQuestion[];
  key: SecretHash | null;
  setAt: string;
  keyIssuedAt: string | null;
  usedAt: string | null;
}

export interface RecoveryAnswerInput {
  questionId: string;
  answer: string;
}

export interface RecoverySetup {
  answers: RecoveryAnswerInput[];
}

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  admin: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  locked: boolean;
  hasPasscode: boolean;
  hasRecovery: boolean;
}

export type AuthEventType =
  | 'setup'
  | 'login'
  | 'login-failed'
  | 'lockout'
  | 'logout'
  | 'locked'
  | 'unlocked'
  | 'password-changed'
  | 'passcode-set'
  | 'passcode-cleared'
  | 'user-created'
  | 'user-removed'
  | 'user-unlocked'
  | 'recovery-set'
  | 'recovery-verified'
  | 'recovery-failed'
  | 'recovery-used'
  | 'delete-confirmed'
  | 'delete-denied';

export interface AuthEvent {
  at: string;
  type: AuthEventType;
  username: string;
  detail?: string;
}

export interface AuthOutcome {
  ok: boolean;
  user?: AuthUser;
  reason?: 'invalid' | 'locked' | 'no-users';
  retryAfterMs?: number;
}

export type SessionState = 'none' | 'active' | 'locked' | 'expired';

interface StoredSession {
  user_id: string;
  token: string;
  started_at: number;
  last_seen: number;
  expires_at: number;
  locked: boolean;
}

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'passw0rd', '1234567890', '123456789', 'qwertyuiop', 'qwerty123',
  'letmein123', 'welcome123', 'admin12345', 'contractor', 'contractoros', 'iloveyou12', 'abcd123456',
  'changeme123', 'construction', 'administrator',
]);

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    throw new Error('Could not save: local storage is full or unavailable.');
  }
}

function emitChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(AUTH_EVENT));
}

function sessionStore(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
function isUser(value: unknown): value is AuthUser {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<AuthUser>;
  return (
    typeof v.id === 'string' &&
    typeof v.username === 'string' &&
    typeof v.displayName === 'string' &&
    typeof v.admin === 'boolean' &&
    isSecretHash(v.password)
  );
}

export function loadUsers(): AuthUser[] {
  const rows = readJson<unknown>(USERS_KEY, []);
  if (!Array.isArray(rows)) return [];
  // Accounts written before recovery existed keep working: the new fields are
  // defaulted on read instead of being patched into storage.
  return rows.filter(isUser).map((u) => ({
    ...u,
    recovery: u.recovery ?? null,
    recoveryFails: typeof u.recoveryFails === 'number' ? u.recoveryFails : 0,
    recoveryLockedUntil: u.recoveryLockedUntil ?? null,
  }));
}

function saveUsers(users: AuthUser[]): void {
  writeJson(USERS_KEY, users);
  emitChanged();
}

export function hasUsers(): boolean {
  return loadUsers().length > 0;
}

export function normalizeUsername(value: string): string {
  return String(value || '').trim().toLowerCase();
}

export function findUser(username: string): AuthUser | null {
  const key = normalizeUsername(username);
  return loadUsers().find((u) => u.username === key) || null;
}

export function userById(id: string): AuthUser | null {
  return loadUsers().find((u) => u.id === id) || null;
}

export function publicUsers(): PublicUser[] {
  const now = Date.now();
  return loadUsers()
    .map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      admin: u.admin,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
      locked: !!u.lockedUntil && u.lockedUntil > now,
      hasPasscode: !!u.passcode,
      hasRecovery: !!u.recovery && (u.recovery.questions.length > 0 || !!u.recovery.key),
    }))
    .sort((a, b) => a.username.localeCompare(b.username));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
export function usernameProblem(username: string): string | null {
  const key = normalizeUsername(username);
  if (!key) return 'Enter a username.';
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(key)) {
    return 'Use 3–32 characters: letters, numbers, dots, dashes or underscores.';
  }
  return null;
}

export function passwordProblems(password: string, username = ''): string[] {
  const problems: string[] = [];
  const pw = String(password || '');
  const nameKey = normalizeUsername(username);

  if (pw.length < PASSWORD_MIN) problems.push(`Use at least ${PASSWORD_MIN} characters.`);
  if (pw.length > 200) problems.push('Keep it under 200 characters.');
  if (nameKey.length >= 3 && pw.toLowerCase().includes(nameKey)) {
    problems.push('Do not put your username in the password.');
  }
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) problems.push('That password is too common — pick something else.');
  if (/^(.)\1*$/.test(pw)) problems.push('Do not repeat one character.');
  if (/^\d+$/.test(pw)) problems.push('Add letters or symbols, not only digits.');
  if (!/[a-zA-Z]/.test(pw)) problems.push('Include at least one letter.');
  return problems;
}

export function passcodeProblem(passcode: string): string | null {
  const pin = String(passcode || '');
  if (!new RegExp(`^\\d{${PASSCODE_LENGTH}}$`).test(pin)) return `The passcode must be exactly ${PASSCODE_LENGTH} digits.`;
  if (/^(\d)\1+$/.test(pin)) return 'Do not repeat the same digit.';
  if (pin === '123456' || pin === '654321' || pin === '000000') return 'That passcode is too easy to guess.';
  return null;
}

/** 0–4, for the strength hint under the field. Never used to accept or reject. */
export function passwordStrength(password: string): number {
  const pw = String(password || '');
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= PASSWORD_MIN) score++;
  if (pw.length >= 14) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  return Math.min(4, score);
}

// ---------------------------------------------------------------------------
// Audit log (no secrets, ever)
// ---------------------------------------------------------------------------
export function loadAuthLog(): AuthEvent[] {
  const rows = readJson<unknown>(LOG_KEY, []);
  return Array.isArray(rows) ? (rows as AuthEvent[]).filter((r) => r && typeof r.at === 'string') : [];
}

function logAuth(type: AuthEventType, username: string, detail?: string): void {
  try {
    const entry: AuthEvent = { at: new Date().toISOString(), type, username: normalizeUsername(username), ...(detail ? { detail } : {}) };
    const next = [entry, ...loadAuthLog()].slice(0, LOG_LIMIT);
    writeJson(LOG_KEY, next);
  } catch {
    /* the audit trail must never block a sign-in */
  }
}

// ---------------------------------------------------------------------------
// Creating and maintaining users
// ---------------------------------------------------------------------------
function newId(): string {
  return `usr-${Date.now().toString(36)}-${randomToken().slice(0, 8)}`;
}

export interface NewUserInput {
  username: string;
  password: string;
  displayName?: string;
  admin?: boolean;
  passcode?: string | null;
  /** Optional at creation; Settings can add it later behind the password. */
  recovery?: RecoverySetup;
  /** Plaintext key generated by createAccount(); hashed before it is stored. */
  recoveryKey?: string;
}

function validateRecoverySetup(setup: RecoverySetup): void {
  const answers = (setup.answers || []).filter(Boolean);
  if (answers.length !== RECOVERY_QUESTION_COUNT) {
    throw new Error(`Choose exactly ${RECOVERY_QUESTION_COUNT} security questions.`);
  }
  const ids = new Set<string>();
  for (const row of answers) {
    const id = String(row.questionId || '').trim();
    if (!id) throw new Error('Every security question needs to be chosen.');
    if (ids.has(id)) throw new Error('Use three different security questions.');
    ids.add(id);
    const problem = answerProblem(row.answer);
    if (problem) throw new Error(problem);
  }
}

async function buildRecovery(setup: RecoverySetup, key: string | undefined): Promise<StoredRecovery> {
  validateRecoverySetup(setup);
  const questions: StoredRecoveryQuestion[] = [];
  for (const row of setup.answers) {
    questions.push({ question_id: row.questionId, answer: await hashAnswer(row.answer, PASSWORD_ITERATIONS) });
  }
  let keyHash: SecretHash | null = null;
  if (key) {
    const problem = recoveryKeyProblem(key);
    if (problem) throw new Error(problem);
    keyHash = await hashRecoveryKey(key, PASSWORD_ITERATIONS);
  }
  return { questions, key: keyHash, setAt: new Date().toISOString(), keyIssuedAt: keyHash ? new Date().toISOString() : null, usedAt: null };
}

export async function createUser(input: NewUserInput): Promise<AuthUser> {
  const username = normalizeUsername(input.username);
  const usernameIssue = usernameProblem(username);
  if (usernameIssue) throw new Error(usernameIssue);
  if (findUser(username)) throw new Error('That username is already taken.');

  const problems = passwordProblems(input.password, username);
  if (problems.length) throw new Error(problems[0]);

  let passcode: SecretHash | null = null;
  if (input.passcode) {
    const pinIssue = passcodeProblem(input.passcode);
    if (pinIssue) throw new Error(pinIssue);
    passcode = await hashSecret(input.passcode, PASSCODE_ITERATIONS);
  }

  const users = loadUsers();
  const recovery = input.recovery ? await buildRecovery(input.recovery, input.recoveryKey) : null;
  const password = await hashSecret(input.password, PASSWORD_ITERATIONS);
  const now = new Date().toISOString();
  const user: AuthUser = {
    id: newId(),
    username,
    displayName: String(input.displayName || '').trim() || username,
    admin: users.length === 0 ? true : !!input.admin, // the first account always administers
    password,
    passcode,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
    failedAttempts: 0,
    lockedUntil: null,
    passcodeFails: 0,
    passcodeLockedUntil: null,
    recovery,
    recoveryFails: 0,
    recoveryLockedUntil: null,
  };
  saveUsers([...users, user]);
  logAuth(users.length === 0 ? 'setup' : 'user-created', username, user.admin ? 'admin' : 'standard');
  if (recovery) logAuth('recovery-set', username, recovery.key ? 'questions + key' : 'questions');
  return user;
}

/**
 * Register an account with recovery set up in one step. Returns the recovery
 * key ONCE — it is never retrievable again, only replaceable.
 */
export async function createAccount(input: NewUserInput & { recovery: RecoverySetup }): Promise<{ user: AuthUser; recoveryKey: string }> {
  validateRecoverySetup(input.recovery);
  const recoveryKey = generateRecoveryKey();
  const user = await createUser({ ...input, recoveryKey });
  return { user, recoveryKey };
}

export async function setPassword(userId: string, password: string, actorId?: string): Promise<void> {
  const users = loadUsers();
  const index = users.findIndex((u) => u.id === userId);
  if (index < 0) throw new Error('That user no longer exists.');
  const target = users[index];
  if (actorId && actorId !== userId) {
    const actor = users.find((u) => u.id === actorId);
    if (!actor?.admin) throw new Error('Only an administrator can reset another user’s password.');
  }
  const problems = passwordProblems(password, target.username);
  if (problems.length) throw new Error(problems[0]);

  users[index] = {
    ...target,
    password: await hashSecret(password, PASSWORD_ITERATIONS),
    updatedAt: new Date().toISOString(),
    failedAttempts: 0,
    lockedUntil: null,
  };
  saveUsers(users);
  logAuth('password-changed', target.username, actorId && actorId !== userId ? 'by admin' : 'self');
}

/** Self-service change: the current password must be proved again. */
export async function changeOwnPassword(userId: string, currentPassword: string, nextPassword: string): Promise<void> {
  const user = userById(userId);
  if (!user) throw new Error('That user no longer exists.');
  const ok = await verifySecret(currentPassword, user.password);
  if (!ok) throw new Error('Your current password is not correct.');
  await setPassword(userId, nextPassword);
}

export async function setPasscode(userId: string, passcode: string | null): Promise<void> {
  const users = loadUsers();
  const index = users.findIndex((u) => u.id === userId);
  if (index < 0) throw new Error('That user no longer exists.');
  if (passcode) {
    const issue = passcodeProblem(passcode);
    if (issue) throw new Error(issue);
  }
  const target = users[index];
  users[index] = {
    ...target,
    passcode: passcode ? await hashSecret(passcode, PASSCODE_ITERATIONS) : null,
    passcodeFails: 0,
    passcodeLockedUntil: null,
    updatedAt: new Date().toISOString(),
  };
  saveUsers(users);
  logAuth(passcode ? 'passcode-set' : 'passcode-cleared', target.username);
}

export function removeUser(userId: string, actorId: string): void {
  const users = loadUsers();
  const actor = users.find((u) => u.id === actorId);
  if (!actor?.admin) throw new Error('Only an administrator can remove a user.');
  const target = users.find((u) => u.id === userId);
  if (!target) throw new Error('That user no longer exists.');
  if (target.id === actor.id) throw new Error('You cannot remove the account you are signed in with.');
  if (target.admin && users.filter((u) => u.admin).length <= 1) throw new Error('Keep at least one administrator.');
  saveUsers(users.filter((u) => u.id !== userId));
  if (readRaw(LAST_USER_KEY) === userId) forgetRememberedUser();
  logAuth('user-removed', target.username, `by ${actor.username}`);
}

export function unlockUser(userId: string, actorId: string): void {
  const users = loadUsers();
  const actor = users.find((u) => u.id === actorId);
  if (!actor?.admin) throw new Error('Only an administrator can unlock an account.');
  const index = users.findIndex((u) => u.id === userId);
  if (index < 0) throw new Error('That user no longer exists.');
  users[index] = { ...users[index], failedAttempts: 0, lockedUntil: null, passcodeFails: 0, passcodeLockedUntil: null };
  saveUsers(users);
  logAuth('user-unlocked', users[index].username, `by ${actor.username}`);
}

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Recovery: questions + key
// ---------------------------------------------------------------------------
export interface RecoveryChallenge {
  ok: boolean;
  reason?: 'unavailable' | 'locked' | 'not-found';
  retryAfterMs?: number;
  userId?: string;
  username?: string;
  displayName?: string;
  questions?: { id: string; label: string }[];
  hasKey?: boolean;
}

/** Public facts needed to run recovery — never returns a hash. */
export function recoveryChallenge(username: string): RecoveryChallenge {
  const user = findUser(username);
  if (!user || !user.recovery) return { ok: false, reason: 'unavailable' };
  const until = user.recoveryLockedUntil || 0;
  if (until > Date.now()) return { ok: false, reason: 'locked', retryAfterMs: until - Date.now() };
  return {
    ok: true,
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    questions: user.recovery.questions.map((q) => ({ id: q.question_id, label: questionLabel(q.question_id) })),
    hasKey: !!user.recovery.key,
  };
}

export interface RecoveryProofInput {
  answers?: string[];
  key?: string;
}

export type RecoveryVerifyResult =
  | { ok: true; ticket: RecoveryTicket; username: string }
  | { ok: false; reason: 'invalid' | 'locked' | 'unavailable'; retryAfterMs?: number; matched?: number };

function recoveryWait(fails: number): number {
  if (fails < RECOVERY_MAX_FAILURES) return 0;
  return Math.min(15 * 60_000, 60_000 * 2 ** (fails - RECOVERY_MAX_FAILURES));
}

/**
 * Prove ownership with two of the three answers, or with the recovery key.
 * Success issues a single-use ticket valid for ten minutes; it does not change
 * the password by itself.
 */
export async function verifyRecovery(userId: string, proof: RecoveryProofInput): Promise<RecoveryVerifyResult> {
  const users = loadUsers();
  const index = users.findIndex((u) => u.id === userId);
  if (index < 0) return { ok: false, reason: 'unavailable' };
  const user = users[index];
  if (!user.recovery) return { ok: false, reason: 'unavailable' };

  const now = Date.now();
  if (user.recoveryLockedUntil && user.recoveryLockedUntil > now) {
    return { ok: false, reason: 'locked', retryAfterMs: user.recoveryLockedUntil - now };
  }

  const fail = (matched: number): RecoveryVerifyResult => {
    const fails = user.recoveryFails + 1;
    const wait = recoveryWait(fails);
    users[index] = { ...user, recoveryFails: fails, recoveryLockedUntil: wait ? now + wait : null };
    saveUsers(users);
    logAuth('recovery-failed', user.username, proof.key ? 'key' : `answers ${matched}/3`);
    if (wait) logAuth('lockout', user.username, `recovery ${Math.round(wait / 1000)}s`);
    return wait ? { ok: false, reason: 'locked', retryAfterMs: wait, matched } : { ok: false, reason: 'invalid', matched };
  };

  let method: RecoveryTicket['method'] = 'questions';
  if (proof.key) {
    if (!user.recovery.key) return fail(0);
    if (!(await verifyRecoveryKey(proof.key, user.recovery.key))) return fail(0);
    method = 'key';
  } else {
    if (user.recovery.questions.length === 0) return fail(0);
    const answers = (proof.answers || []).map((a) => String(a || ''));
    let matched = 0;
    for (const [i, stored] of user.recovery.questions.entries()) {
      if (await verifyAnswer(answers[i] || '', stored.answer)) matched++;
    }
    if (matched < Math.min(RECOVERY_ANSWER_THRESHOLD, user.recovery.questions.length)) return fail(matched);
    method = 'questions';
  }

  users[index] = { ...user, recoveryFails: 0, recoveryLockedUntil: null };
  saveUsers(users);
  const ticket = issueRecoveryTicket(user.id, method);
  logAuth('recovery-verified', user.username, method);
  return { ok: true, ticket, username: user.username };
}

export interface ResetOutcome {
  ok: boolean;
  username?: string;
  reason?: 'ticket' | 'expired' | 'weak';
  message?: string;
}

/** Consume a recovery ticket and set a new password (and optionally passcode). */
export async function resetPasswordWithRecovery(token: string, newPassword: string): Promise<ResetOutcome> {
  const ticket = readRecoveryTicket(token);
  if (!ticket) return { ok: false, reason: 'ticket', message: 'This recovery session expired. Start again.' };
  const users = loadUsers();
  const index = users.findIndex((u) => u.id === ticket.user_id);
  if (index < 0) {
    clearRecoveryTicket();
    return { ok: false, reason: 'ticket', message: 'That account no longer exists.' };
  }
  const user = users[index];
  const problems = passwordProblems(newPassword, user.username);
  if (problems.length) return { ok: false, reason: 'weak', message: problems[0] };

  users[index] = {
    ...user,
    password: await hashSecret(newPassword, PASSWORD_ITERATIONS),
    updatedAt: new Date().toISOString(),
    failedAttempts: 0,
    lockedUntil: null,
    passcodeFails: 0,
    passcodeLockedUntil: null,
    recovery: user.recovery ? { ...user.recovery, usedAt: new Date().toISOString() } : null,
    recoveryFails: 0,
    recoveryLockedUntil: null,
  };
  saveUsers(users);
  clearRecoveryTicket();
  // Any live session for that account must not survive a password reset.
  writeSession(null);
  logAuth('recovery-used', user.username, ticket.method);
  emitChanged();
  return { ok: true, username: user.username };
}

export function recoveryStatus(userId: string): { questions: number; hasKey: boolean; setAt: string | null; usedAt: string | null } {
  const user = userById(userId);
  if (!user?.recovery) return { questions: 0, hasKey: false, setAt: null, usedAt: null };
  return {
    questions: user.recovery.questions.length,
    hasKey: !!user.recovery.key,
    setAt: user.recovery.setAt || null,
    usedAt: user.recovery.usedAt || null,
  };
}

async function provePassword(userId: string, password: string): Promise<AuthUser> {
  const users = loadUsers();
  const index = users.findIndex((u) => u.id === userId);
  if (index < 0) throw new Error('That account no longer exists.');
  if (!(await verifySecret(password, users[index].password))) throw new Error('Your password is not correct.');
  return users[index];
}

/** Replace the three questions (the recovery key, if any, stays valid). */
export async function setRecoveryQuestions(userId: string, password: string, setup: RecoverySetup): Promise<void> {
  const user = await provePassword(userId, password);
  validateRecoverySetup(setup);
  const questions: StoredRecoveryQuestion[] = [];
  for (const row of setup.answers) {
    questions.push({ question_id: row.questionId, answer: await hashAnswer(row.answer, PASSWORD_ITERATIONS) });
  }
  const users = loadUsers().map((u) =>
    u.id === userId
      ? {
          ...u,
          recovery: {
            questions,
            key: u.recovery?.key ?? null,
            setAt: new Date().toISOString(),
            keyIssuedAt: u.recovery?.keyIssuedAt ?? null,
            usedAt: u.recovery?.usedAt ?? null,
          },
          recoveryFails: 0,
          recoveryLockedUntil: null,
        }
      : u
  );
  saveUsers(users);
  logAuth('recovery-set', user.username, 'questions updated');
}

/** Issue a fresh recovery key; the old one stops working immediately. */
export async function rotateRecoveryKey(userId: string, password: string): Promise<string> {
  const user = await provePassword(userId, password);
  const key = generateRecoveryKey();
  const hashed = await hashRecoveryKey(key, PASSWORD_ITERATIONS);
  const users = loadUsers().map((u) =>
    u.id === userId
      ? {
          ...u,
          recovery: {
            questions: u.recovery?.questions ?? [],
            key: hashed,
            setAt: u.recovery?.setAt || new Date().toISOString(),
            keyIssuedAt: new Date().toISOString(),
            usedAt: null,
          },
          recoveryFails: 0,
          recoveryLockedUntil: null,
        }
      : u
  );
  saveUsers(users);
  logAuth('recovery-set', user.username, 'key rotated');
  return key;
}

export function hasRecovery(userId: string): boolean {
  const user = userById(userId);
  return !!user?.recovery && (user.recovery.questions.length > 0 || !!user.recovery.key);
}

export { normalizeRecoveryKey };

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------
function backoffMs(attempts: number): number {
  if (attempts < MAX_FAILURES) return 0;
  return Math.min(15 * 60_000, 30_000 * 2 ** (attempts - MAX_FAILURES));
}

async function burnTime(password: string): Promise<void> {
  // A missing username must cost the same as a wrong password, or the delay
  // itself tells an attacker which usernames exist.
  try {
    await hashSecret(password, PASSWORD_ITERATIONS);
  } catch {
    /* crypto unavailable: nothing to equalise */
  }
}

export async function authenticate(username: string, password: string): Promise<AuthOutcome> {
  const users = loadUsers();
  if (users.length === 0) return { ok: false, reason: 'no-users' };

  const key = normalizeUsername(username);
  const index = users.findIndex((u) => u.username === key);
  if (index < 0) {
    await burnTime(password);
    logAuth('login-failed', key, 'unknown user');
    return { ok: false, reason: 'invalid' };
  }

  const user = users[index];
  const now = Date.now();
  if (user.lockedUntil && user.lockedUntil > now) {
    logAuth('lockout', user.username, 'still locked');
    return { ok: false, reason: 'locked', retryAfterMs: user.lockedUntil - now };
  }

  const ok = await verifySecret(password, user.password);
  if (!ok) {
    const failedAttempts = user.failedAttempts + 1;
    const wait = backoffMs(failedAttempts);
    users[index] = {
      ...user,
      failedAttempts,
      lockedUntil: wait > 0 ? now + wait : null,
    };
    saveUsers(users);
    logAuth('login-failed', user.username, `attempt ${failedAttempts}`);
    if (wait > 0) {
      logAuth('lockout', user.username, `${Math.round(wait / 1000)}s`);
      return { ok: false, reason: 'locked', retryAfterMs: wait };
    }
    return { ok: false, reason: 'invalid' };
  }

  const signedIn: AuthUser = {
    ...user,
    failedAttempts: 0,
    lockedUntil: null,
    lastLoginAt: new Date().toISOString(),
  };
  users[index] = signedIn;
  saveUsers(users);
  rememberUser(user.id);
  logAuth('login', user.username);
  return { ok: true, user: signedIn };
}

// ---------------------------------------------------------------------------
// Remembered account + passcode sign-in
// ---------------------------------------------------------------------------
function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* remembering is a convenience, never a requirement */
  }
}

export function rememberUser(userId: string | null): void {
  writeRaw(LAST_USER_KEY, userId);
}

/** The account this computer last signed in with, if it still exists. */
export function rememberedUser(): AuthUser | null {
  const id = readRaw(LAST_USER_KEY);
  if (!id) return null;
  const user = userById(id);
  if (!user) {
    writeRaw(LAST_USER_KEY, null);
    return null;
  }
  return user;
}

export function forgetRememberedUser(): void {
  writeRaw(LAST_USER_KEY, null);
}

/**
 * Sign in with the 6-digit passcode of the remembered account.
 * This opens a real session (there is none yet), so it is deliberately the
 * weakest door in the app: only that account, only with a passcode set, and
 * five wrong digits put it behind a cooldown that only the password clears.
 */
export async function authenticateWithPasscode(userId: string, passcode: string): Promise<AuthOutcome> {
  const users = loadUsers();
  const index = users.findIndex((u) => u.id === userId);
  if (index < 0) return { ok: false, reason: 'invalid' };
  const user = users[index];
  if (!user.passcode) return { ok: false, reason: 'invalid' };

  const now = Date.now();
  const until = user.passcodeLockedUntil || 0;
  if (until > now) return { ok: false, reason: 'locked', retryAfterMs: until - now };
  if (user.lockedUntil && user.lockedUntil > now) return { ok: false, reason: 'locked', retryAfterMs: user.lockedUntil - now };

  const ok = await verifySecret(passcode, user.passcode);
  if (!ok) {
    const fails = user.passcodeFails + 1;
    // A 6-digit secret is guessable at speed, so the cooldown is longer than
    // the password's first step and grows with every further miss.
    const wait = fails >= MAX_FAILURES ? Math.min(15 * 60_000, 5 * 60_000 * 2 ** (fails - MAX_FAILURES)) : 0;
    users[index] = { ...user, passcodeFails: fails, passcodeLockedUntil: wait ? now + wait : null };
    saveUsers(users);
    logAuth('login-failed', user.username, `passcode sign-in ${fails}`);
    if (wait) logAuth('lockout', user.username, `passcode ${Math.round(wait / 1000)}s`);
    return wait ? { ok: false, reason: 'locked', retryAfterMs: wait } : { ok: false, reason: 'invalid' };
  }

  const signedIn: AuthUser = {
    ...user,
    passcodeFails: 0,
    passcodeLockedUntil: null,
    failedAttempts: 0,
    lockedUntil: null,
    lastLoginAt: new Date().toISOString(),
  };
  users[index] = signedIn;
  saveUsers(users);
  rememberUser(user.id);
  logAuth('login', user.username, 'passcode');
  return { ok: true, user: signedIn };
}

// ---------------------------------------------------------------------------
// Destructive-action guard
//
// Deleting real data needs the signed-in user's own secret — their passcode
// when one is set, and their account password either way. The check is done
// here, against the stored hash, so a UI that forgets to call it still cannot
// be the only line of defence: the dialog asks, this verifies.
//
// Failures share the passcode counters, so a person hammering the delete prompt
// is backed off exactly like someone guessing at the sign-in screen, and every
// attempt lands in the security log.
// ---------------------------------------------------------------------------
export type DeleteSecretKind = 'passcode' | 'password';

export interface DeleteSecretCheck {
  ok: boolean;
  requires: DeleteSecretKind;
  reason?: 'invalid' | 'locked' | 'no-session';
  retryAfterMs?: number;
}

/** Which secret this account will be asked for. */
export function deleteSecretKind(): DeleteSecretKind {
  return activeUser()?.passcode ? 'passcode' : 'password';
}

/** Verify the signed-in user's secret before a destructive action. */
export async function verifyDeleteSecret(secret: string): Promise<DeleteSecretCheck> {
  const user = activeUser();
  const requires: DeleteSecretKind = user?.passcode ? 'passcode' : 'password';
  if (!user) return { ok: false, requires: 'passcode', reason: 'no-session' };

  const now = Date.now();
  const until = user.passcodeLockedUntil || 0;
  if (until > now) return { ok: false, requires, reason: 'locked', retryAfterMs: until - now };

  const value = String(secret || '');
  if (!value) return { ok: false, requires, reason: 'invalid' };

  // Either secret is accepted when a passcode exists: the passcode is the
  // short one, the password is the long recovery from a forgotten passcode.
  const records: SecretHash[] = user.passcode ? [user.passcode, user.password] : [user.password];
  let ok = false;
  for (const record of records) {
    if (await verifySecret(value, record)) {
      ok = true;
      break;
    }
  }

  const users = loadUsers();
  const index = users.findIndex((u) => u.id === user.id);
  if (index < 0) return { ok: false, requires, reason: 'no-session' };

  if (!ok) {
    const fails = user.passcodeFails + 1;
    const wait = fails >= MAX_FAILURES ? Math.min(15 * 60_000, 5 * 60_000 * 2 ** (fails - MAX_FAILURES)) : 0;
    users[index] = { ...user, passcodeFails: fails, passcodeLockedUntil: wait ? now + wait : null };
    saveUsers(users);
    logAuth('delete-denied', user.username, `${requires} attempt ${fails}`);
    if (wait) logAuth('lockout', user.username, `delete guard ${Math.round(wait / 1000)}s`);
    return { ok: false, requires, reason: wait ? 'locked' : 'invalid', retryAfterMs: wait || undefined };
  }

  users[index] = { ...user, passcodeFails: 0, passcodeLockedUntil: null };
  saveUsers(users);
  logAuth('delete-confirmed', user.username, requires);
  return { ok: true, requires };
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
export function readSession(): StoredSession | null {
  const store = sessionStore();
  if (!store) return null;
  try {
    const raw = store.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed || typeof parsed.user_id !== 'string' || typeof parsed.token !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeSession(session: StoredSession | null): void {
  const store = sessionStore();
  if (!store) return;
  try {
    if (session) store.setItem(SESSION_KEY, JSON.stringify(session));
    else store.removeItem(SESSION_KEY);
  } catch {
    /* session storage unavailable — the gate falls back to signed out */
  }
}

export function startSession(user: AuthUser): StoredSession {
  const now = Date.now();
  const session: StoredSession = {
    user_id: user.id,
    token: randomToken(),
    started_at: now,
    last_seen: now,
    expires_at: now + SESSION_HOURS * 60 * 60_000,
    locked: false,
  };
  writeSession(session);
  // A fresh sign-in clears the "you signed out" memory, so quick passcode
  // entry becomes available again for the next lock.
  writeRaw(SIGNED_OUT_KEY, null);
  emitChanged();
  return session;
}

export function sessionState(): SessionState {
  const session = readSession();
  if (!session) return 'none';
  const now = Date.now();
  if (now >= session.expires_at) return 'expired';
  if (now - session.last_seen > IDLE_MINUTES * 60_000) return 'expired';
  if (session.locked) return 'locked';
  return 'active';
}

/** The signed-in user, only while the session is genuinely usable. */
export function activeUser(): AuthUser | null {
  const session = readSession();
  if (!session || sessionState() !== 'active') return null;
  return userById(session.user_id);
}

export function lockedUser(): AuthUser | null {
  const session = readSession();
  if (!session || sessionState() !== 'locked') return null;
  return userById(session.user_id);
}

/** Refresh the idle clock — called on real user activity only. */
export function touchSession(): void {
  if (sessionState() !== 'active') return;
  const session = readSession();
  if (!session) return;
  writeSession({ ...session, last_seen: Date.now() });
}

export function lockSession(): void {
  const session = readSession();
  if (!session || sessionState() === 'expired') return;
  // Locking restarts the idle clock: the passcode grace window begins now, not
  // at the last click before the screen locked itself.
  writeSession({ ...session, locked: true, last_seen: Date.now() });
  logAuth('locked', userById(session.user_id)?.username || 'unknown');
  emitChanged();
}

export function signOut(reason: 'manual' | 'expired' = 'manual'): void {
  const session = readSession();
  if (session) logAuth('logout', userById(session.user_id)?.username || 'unknown');
  writeSession(null);
  // Remember WHY: an explicit sign-out must not look like a lock, and the next
  // person at the machine must be asked for the password, not a 6-digit PIN.
  writeRaw(SIGNED_OUT_KEY, reason === 'manual' ? new Date().toISOString() : null);
  clearRecoveryTicket();
  emitChanged();
}

/** True after an explicit sign-out, until the next successful session starts. */
export function signedOutAt(): string | null {
  return readRaw(SIGNED_OUT_KEY);
}

export function clearSignedOut(): void {
  writeRaw(SIGNED_OUT_KEY, null);
}

export interface UnlockOutcome {
  ok: boolean;
  reason?: 'no-session' | 'invalid' | 'locked-down';
  retryAfterMs?: number;
}

/**
 * Unlock a locked session with the 6-digit passcode (or the password).
 * A locked app is not a signed-out app, but it is not a free pass either: the
 * passcode only works inside the idle grace window (from the moment of lock).
 * Past that — or past the absolute session limit — the password is required.
 */
export async function unlockSession(secret: string): Promise<UnlockOutcome> {
  const session = readSession();
  if (!session) return { ok: false, reason: 'no-session' };
  const now0 = Date.now();
  const idleDead = now0 - session.last_seen > IDLE_MINUTES * 60_000;
  if (now0 >= session.expires_at || idleDead) return { ok: false, reason: 'no-session' };

  const users = loadUsers();
  const index = users.findIndex((u) => u.id === session.user_id);
  if (index < 0) return { ok: false, reason: 'no-session' };
  const user = users[index];
  const now = now0;
  const asPin = new RegExp(`^\\d{${PASSCODE_LENGTH}}$`).test(secret);

  if (asPin && user.passcode) {
    if (user.passcodeLockedUntil && user.passcodeLockedUntil > now) {
      return { ok: false, reason: 'locked-down', retryAfterMs: user.passcodeLockedUntil - now };
    }
    if (await verifySecret(secret, user.passcode)) {
      users[index] = { ...user, passcodeFails: 0, passcodeLockedUntil: null, failedAttempts: 0, lockedUntil: null };
      saveUsers(users);
      writeSession({ ...session, locked: false, last_seen: now });
      logAuth('unlocked', user.username, 'passcode');
      emitChanged();
      return { ok: true };
    }
    const fails = user.passcodeFails + 1;
    const lockFor = fails >= MAX_FAILURES ? 60_000 : 0;
    users[index] = { ...user, passcodeFails: fails, passcodeLockedUntil: lockFor ? now + lockFor : null };
    saveUsers(users);
    logAuth('login-failed', user.username, `passcode attempt ${fails}`);
    return lockFor ? { ok: false, reason: 'locked-down', retryAfterMs: lockFor } : { ok: false, reason: 'invalid' };
  }

  // Password fallback (also the path for users with no passcode).
  if (user.lockedUntil && user.lockedUntil > now) {
    return { ok: false, reason: 'locked-down', retryAfterMs: user.lockedUntil - now };
  }
  if (await verifySecret(secret, user.password)) {
    users[index] = { ...user, failedAttempts: 0, lockedUntil: null, passcodeFails: 0, passcodeLockedUntil: null };
    saveUsers(users);
    writeSession({ ...session, locked: false, last_seen: now });
    logAuth('unlocked', user.username, 'password');
    emitChanged();
    return { ok: true };
  }
  // A wrong password here must cost the same as a wrong password at sign-in;
  // otherwise the lock screen is an unthrottled oracle for the password.
  const failed = user.failedAttempts + 1;
  const wait = backoffMs(failed);
  users[index] = { ...user, failedAttempts: failed, lockedUntil: wait > 0 ? now + wait : null };
  saveUsers(users);
  logAuth('login-failed', user.username, `unlock failed ${failed}`);
  if (wait > 0) {
    logAuth('lockout', user.username, `${Math.round(wait / 1000)}s`);
    return { ok: false, reason: 'locked-down', retryAfterMs: wait };
  }
  return { ok: false, reason: 'invalid' };
}
