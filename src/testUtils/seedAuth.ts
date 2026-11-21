// Test helper: put a real signed-in account in place so the destructive-action
// guard has something to verify against. Uses the genuine auth service, so the
// stored passcode is a PBKDF2 hash exactly as in the app.
import { webcrypto } from 'node:crypto';
import { createUser, startSession, type AuthUser } from '../services/auth/authService';

export const TEST_PASSWORD = 'Example#2026';
export const TEST_PASSCODE = '482915';

export async function seedSignedInUser(
  options: { passcode?: string | null; password?: string; username?: string } = {}
): Promise<AuthUser> {
  // jsdom ships getRandomValues but not SubtleCrypto; Node has both.
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
  const user = await createUser({
    username: options.username ?? 'testeditor',
    password: options.password ?? TEST_PASSWORD,
    displayName: 'Test Editor',
    passcode: options.passcode === undefined ? TEST_PASSCODE : options.passcode,
  });
  startSession(user);
  return user;
}
