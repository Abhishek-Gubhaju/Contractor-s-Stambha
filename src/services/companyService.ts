// ============================================================================
// companyService — the seller block of every printed document.
//
// A Nepali tax invoice is only valid with the supplier's name, address and PAN
// printed on it (Rule 17, VAT Rules 2053), so these values are configuration,
// not decoration: they travel with every bill, invoice, debit note and credit
// note the app prints.
//
// Offline and per job like every other store, so two companies' jobs never
// print each other's identity; nothing is seeded, so it is entered once in
// Settings.
// ============================================================================

import { readScoped, writeScoped } from './projectScope';

export const COMPANY_KEY = 'contractoros_company';

export interface CompanyProfile {
  name: string;
  address: string;
  phone: string;
  email: string;
  /** Permanent Account Number (PAN) — mandatory on every tax invoice. */
  pan: string;
  /** VAT registration number, when the firm is VAT registered. */
  vatNo: string;
  /** Shown at the foot of a printed document. */
  footer: string;
  /** Optional letterhead logo as a data URL (offline, never uploaded). */
  logo: string;
}

export const EMPTY_COMPANY: CompanyProfile = {
  name: '',
  address: '',
  phone: '',
  email: '',
  pan: '',
  vatNo: '',
  footer: '',
  logo: '',
};

export function loadCompany(): CompanyProfile {
  try {
    const stored = readScoped<Partial<CompanyProfile>>(COMPANY_KEY, {});
    return {
      name: String(stored.name || ''),
      address: String(stored.address || ''),
      phone: String(stored.phone || ''),
      email: String(stored.email || ''),
      pan: String(stored.pan || ''),
      vatNo: String(stored.vatNo || ''),
      footer: String(stored.footer || ''),
      logo: String(stored.logo || ''),
    };
  } catch {
    return { ...EMPTY_COMPANY };
  }
}

export function saveCompany(patch: Partial<CompanyProfile>): CompanyProfile {
  const next = { ...loadCompany(), ...patch };
  writeScoped(COMPANY_KEY, next);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('contractoros:books-changed'));
  }
  return next;
}

/**
 * A printed document needs at least a name and a PAN. The UI warns instead of
 * blocking a posting: books must be able to record a bill before the letterhead
 * is filled in.
 */
export function companyReady(p: CompanyProfile = loadCompany()): boolean {
  return Boolean(p.name.trim() && p.pan.trim());
}
