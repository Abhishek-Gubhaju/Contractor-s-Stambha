// ============================================================================
// taxService — VAT and TDS, the two statutory layers a contractor's books must
// carry on top of the double-entry core.
//
//   • Settings are per job (same pattern as the fiscal year in periods.ts) and
//     only supply DEFAULTS to the entry forms. The posting engine never reads
//     them, so recipe() stays pure and preview == truth.
//   • VAT is opt-in per document: a rate of 0 posts no tax line, so migrated
//     data and tax-free documents keep posting exactly as they did before.
//   • TDS is deducted from the TAXABLE (VAT-exclusive) value, never from VAT.
//   • Rounding: every figure is 2-dp; base + vat === total and
//     total − tds === net, so every posting built from one breakdown balances.
// ============================================================================

import { readScoped, writeScoped } from './projectScope';

export const TAX_SETTINGS_KEY = 'contractoros_tax_settings';

export interface TaxSettings {
  vatEnabled: boolean;
  /** VAT percent, e.g. 13. */
  vatRate: number;
  tdsEnabled: boolean;
  /** Default TDS percent for services/rent, e.g. 1.5. */
  tdsRate: number;
}

export const DEFAULT_TAX_SETTINGS: TaxSettings = {
  vatEnabled: true,
  vatRate: 13,
  tdsEnabled: true,
  tdsRate: 1.5,
};

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const clampRate = (n: unknown) => Math.min(100, Math.max(0, Number(n) || 0));

export function loadTaxSettings(): TaxSettings {
  try {
    const stored = readScoped<Partial<TaxSettings>>(TAX_SETTINGS_KEY, {});
    return {
      vatEnabled: stored.vatEnabled ?? DEFAULT_TAX_SETTINGS.vatEnabled,
      vatRate: clampRate(stored.vatRate ?? DEFAULT_TAX_SETTINGS.vatRate),
      tdsEnabled: stored.tdsEnabled ?? DEFAULT_TAX_SETTINGS.tdsEnabled,
      tdsRate: clampRate(stored.tdsRate ?? DEFAULT_TAX_SETTINGS.tdsRate),
    };
  } catch {
    return { ...DEFAULT_TAX_SETTINGS };
  }
}

export function saveTaxSettings(patch: Partial<TaxSettings>): TaxSettings {
  const next: TaxSettings = { ...loadTaxSettings(), ...patch };
  next.vatRate = clampRate(next.vatRate);
  next.tdsRate = clampRate(next.tdsRate);
  next.vatEnabled = Boolean(next.vatEnabled);
  next.tdsEnabled = Boolean(next.tdsEnabled);
  writeScoped(TAX_SETTINGS_KEY, next);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('contractoros:books-changed'));
  }
  return next;
}

/** Default VAT percent a new document should offer (0 when VAT is off). */
export function defaultVatRate(): number {
  const s = loadTaxSettings();
  return s.vatEnabled ? s.vatRate : 0;
}

/** Default TDS percent a new document should offer (0 when TDS is off). */
export function defaultTdsRate(): number {
  const s = loadTaxSettings();
  return s.tdsEnabled ? s.tdsRate : 0;
}

export interface TaxBreakdown {
  /** Taxable value (VAT-exclusive). What the expense/income line carries. */
  base: number;
  vat: number;
  tds: number;
  /** base + vat — the invoice/bill total including VAT. */
  total: number;
  /** total − tds — what actually remains to be paid (the payable line). */
  net: number;
}

/**
 * Split an entered amount into base / VAT / TDS.
 *
 * `gross` is what the user typed. When `vatIncluded` the gross already carries
 * VAT and is split backwards, so the document total never drifts; otherwise
 * VAT is added on top of the gross.
 */
export function taxBreakdown(input: {
  gross: number;
  vatRate?: number;
  vatIncluded?: boolean;
  tdsRate?: number;
}): TaxBreakdown {
  const gross = round2(input.gross);
  const rate = clampRate(input.vatRate);
  const tdsRate = clampRate(input.tdsRate);

  let base = gross;
  let vat = 0;
  if (rate > 0) {
    if (input.vatIncluded) {
      base = round2(gross / (1 + rate / 100));
      vat = round2(gross - base);
    } else {
      vat = round2((gross * rate) / 100);
    }
  }

  const tds = round2((base * tdsRate) / 100);
  const total = round2(base + vat);
  return { base, vat, tds, total, net: round2(total - tds) };
}
