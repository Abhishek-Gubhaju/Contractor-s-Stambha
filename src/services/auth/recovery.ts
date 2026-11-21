// ============================================================================
// recovery — the parts of account recovery that are pure.
//
// Recovery has two independent doors, both stored ONLY as hashes:
//   1. three security questions (any two correct answers are enough)
//   2. a one-time-shown recovery key (20 characters, generated locally)
//
// Nothing here touches the user store; authService owns that. Keeping the
// normalisation, key format and ticket rules in one small module means the
// login screen, Settings and the tests all agree on what "the same answer"
// or "the same key" means.
// ============================================================================
import { deriveSecret, hashSecret, randomBytes, randomToken, timingSafeEqual, verifySecret, type SecretHash } from './crypto';

export interface RecoveryQuestionOption {
  id: string;
  label: string;
}

/**
 * Fixed, answerable questions. They are suggestions of what a site engineer
 * remembers years later; the stored answer is normalised before hashing.
 */
export const RECOVERY_QUESTIONS: RecoveryQuestionOption[] = [
  { id: 'birth-city', label: 'In which city or village were you born?' },
  { id: 'first-school', label: 'What was the name of your first school?' },
  { id: 'first-employer', label: 'Who was your first employer?' },
  { id: 'childhood-nickname', label: 'What was your childhood nickname?' },
  { id: 'first-vehicle', label: 'What was the model of your first vehicle?' },
  { id: 'first-project', label: 'What was the name of the first project you worked on?' },
  { id: 'mother-maiden', label: 'What is your mother’s maiden name?' },
  { id: 'home-town', label: 'Which town do you call your home ground?' },
];

export const RECOVERY_QUESTION_COUNT = 3;
/** Any two of the three correct answers open the recovery door. */
export const RECOVERY_ANSWER_THRESHOLD = 2;
export const RECOVERY_KEY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // no I, L, O, U, 0, 1
export const RECOVERY_KEY_LENGTH = 20;
export const RECOVERY_TICKET_MINUTES = 10;
export const RECOVERY_MAX_FAILURES = 5;

export const RECOVERY_TICKET_KEY = 'contractoros_auth_recovery_ticket';

/** The options, in a stable order, for the setup/recovery forms. */
export function recoveryQuestionOptions(): RecoveryQuestionOption[] {
  return RECOVERY_QUESTIONS.slice();
}

export function questionLabel(id: string): string {
  return RECOVERY_QUESTIONS.find((q) => q.id === id)?.label || id;
}

/**
 * Normalise an answer before it is hashed or compared: Unicode NFKC, trimmed,
 * internal whitespace collapsed, lower-cased. " Kathmandu " and "kathmandu"
 * are therefore the same answer.
 */
export function normalizeAnswer(value: string): string {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    // Punctuation and symbols are not something anyone remembers reliably:
    // "Example School", "st xavier" and "St Xavier" are the same answer.
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function answerProblem(value: string): string | null {
  const answer = normalizeAnswer(value);
  if (answer.length < 2) return 'Give an answer of at least two characters.';
  if (answer.length > 120) return 'Keep the answer under 120 characters.';
  return null;
}

export async function hashAnswer(value: string, iterations: number): Promise<SecretHash> {
  return hashSecret(normalizeAnswer(value), iterations);
}

export async function verifyAnswer(value: string, record: SecretHash): Promise<boolean> {
  const current = normalizeAnswer(value);
  if (await verifySecret(current, record)) return true;
  // Answers hashed before punctuation was stripped must keep working.
  const legacy = String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
  return legacy !== current ? verifySecret(legacy, record) : false;
}

// ---------------------------------------------------------------------------
// Recovery key
// ---------------------------------------------------------------------------
/** A fresh key, shown once: XXXXX-XXXXX-XXXXX-XXXXX (20 symbols, ~96 bits). */
export function generateRecoveryKey(): string {
  const bytes = randomBytes(RECOVERY_KEY_LENGTH);
  let raw = '';
  for (const byte of bytes) raw += RECOVERY_KEY_ALPHABET[byte % RECOVERY_KEY_ALPHABET.length];
  return formatRecoveryKey(raw);
}

export function formatRecoveryKey(raw: string): string {
  const clean = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return clean.match(/.{1,4}/g)?.join('-') || '';
}

/** Dashes, spaces and lower case are all forgiven; anything else is not. */
export function normalizeRecoveryKey(value: string): string {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function recoveryKeyProblem(value: string): string | null {
  const key = normalizeRecoveryKey(value);
  if (key.length !== RECOVERY_KEY_LENGTH) return `A recovery key has ${RECOVERY_KEY_LENGTH} characters (five groups of four).`;
  if (![...key].every((c) => RECOVERY_KEY_ALPHABET.includes(c))) {
    return 'That is not a recovery key — check for letters like I, L, O or U and digits 0 or 1.';
  }
  return null;
}

/** Hash a key exactly as typed (normalised), never storing the plaintext. */
export async function hashRecoveryKey(value: string, iterations: number): Promise<SecretHash> {
  return hashSecret(normalizeRecoveryKey(value), iterations);
}

export async function verifyRecoveryKey(value: string, record: SecretHash): Promise<boolean> {
  if (recoveryKeyProblem(value)) return false;
  return verifySecret(normalizeRecoveryKey(value), record);
}

// ---------------------------------------------------------------------------
// Recovery ticket — proof that the questions/key were answered in this tab
// ---------------------------------------------------------------------------
export interface RecoveryTicket {
  token: string;
  user_id: string;
  method: 'questions' | 'key' | 'admin';
  expires_at: number;
}

function store(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function issueRecoveryTicket(userId: string, method: RecoveryTicket['method']): RecoveryTicket {
  const ticket: RecoveryTicket = {
    token: randomToken(),
    user_id: userId,
    method,
    expires_at: Date.now() + RECOVERY_TICKET_MINUTES * 60_000,
  };
  try {
    store()?.setItem(RECOVERY_TICKET_KEY, JSON.stringify(ticket));
  } catch {
    /* the caller still gets a usable ticket object in memory for this call */
  }
  return ticket;
}

export function readRecoveryTicket(token?: string): RecoveryTicket | null {
  try {
    const raw = store()?.getItem(RECOVERY_TICKET_KEY);
    if (!raw) return null;
    const ticket = JSON.parse(raw) as RecoveryTicket;
    if (!ticket || typeof ticket.user_id !== 'string' || typeof ticket.token !== 'string') return null;
    if (Date.now() >= ticket.expires_at) return null;
    if (token && !timingSafeEqual(token, ticket.token)) return null;
    return ticket;
  } catch {
    return null;
  }
}

export function clearRecoveryTicket(): void {
  try {
    store()?.removeItem(RECOVERY_TICKET_KEY);
  } catch {
    /* nothing to clear */
  }
}
