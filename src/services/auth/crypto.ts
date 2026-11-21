// ============================================================================
// crypto — the only place secrets are hashed.
//
// PBKDF2-HMAC-SHA256 via WebCrypto: every password and PIN is stored as a
// salted, stretched hash. Nothing reversible ever reaches localStorage, and a
// verification compares fixed-length hex strings in constant time so a wrong
// guess cannot be narrowed down by response timing.
//
// 210,000 iterations is the OWASP figure for PBKDF2-SHA256 (600,000 is their
// current recommendation for a fast desktop CPU; this app also runs inside a
// laptop/phone webview where that would cost seconds per unlock). The cost is
// recorded in each stored hash, so raising it later only affects new secrets —
// old hashes keep verifying with their own iteration count.
// ============================================================================

export const PASSWORD_ITERATIONS = 210_000;
export const PASSCODE_ITERATIONS = 210_000;

export interface SecretHash {
  algo: 'pbkdf2-sha256';
  iterations: number;
  salt: string; // base64
  hash: string; // hex
}

const encoder = new TextEncoder();

function subtle(): SubtleCrypto {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (!c || !c.subtle) {
    throw new Error('This system has no secure cryptography (WebCrypto unavailable).');
  }
  return c.subtle;
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (!c || !c.getRandomValues) throw new Error('This system has no secure random source.');
  c.getRandomValues(out);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Compare two strings without leaking where they differ. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Raw PBKDF2 output as hex — the expensive step behind both hashing and verifying. */
export async function deriveSecret(secret: string, salt: Uint8Array, iterations: number): Promise<string> {
  const material = await subtle().importKey('raw', encoder.encode(secret.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle().deriveBits(
    { name: 'PBKDF2', salt: new Uint8Array(salt), iterations, hash: 'SHA-256' },
    material,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

export async function hashSecret(secret: string, iterations: number): Promise<SecretHash> {
  const salt = randomBytes(16);
  const hash = await deriveSecret(secret, salt, iterations);
  return { algo: 'pbkdf2-sha256', iterations, salt: bytesToBase64(salt), hash };
}

export async function verifySecret(secret: string, record: SecretHash): Promise<boolean> {
  if (!isSecretHash(record)) return false;
  try {
    const derived = await deriveSecret(secret, base64ToBytes(record.salt), record.iterations);
    return timingSafeEqual(derived, record.hash);
  } catch {
    return false;
  }
}

/** Shape check for anything read back out of storage. */
export function isSecretHash(value: unknown): value is SecretHash {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<SecretHash>;
  return (
    v.algo === 'pbkdf2-sha256' &&
    typeof v.iterations === 'number' &&
    v.iterations > 0 &&
    typeof v.salt === 'string' &&
    v.salt.length > 0 &&
    typeof v.hash === 'string' &&
    /^[0-9a-f]{64}$/.test(v.hash)
  );
}

/** A random opaque session token (not a secret that grants data access on its own). */
export function randomToken(): string {
  return bytesToHex(randomBytes(32));
}
