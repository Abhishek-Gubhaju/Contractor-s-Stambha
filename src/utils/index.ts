// ============ CURRENCY & NUMBER FORMATTING ============

import { adToBS, bsToAD } from "./nepaliDate";

/**
 * Formats a number as currency string (e.g., "NRS 1,234")
 * Matches the original App.tsx implementation exactly.
 */
export function formatCurrency(amount: number): string {
  return `NRS ${amount.toLocaleString()}`;
}

/**
 * Minimal class-name joiner (variant of clsx for string/conditional args).
 * Keeps components free of manual `.filter(Boolean).join(' ')` calls.
 */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

/**
 * Formats amount as Rs. : Ps.
 * @param amount - The amount to format
 * @returns Object with rupees and paisa strings
 */
export function formatAmountRsPs(amount: number): { rupees: string; paisa: string } {
  const rupees = Math.floor(amount);
  const paisa = Math.round((amount - rupees) * 100);
  return {
    rupees: rupees.toLocaleString('en-NP'),
    paisa: paisa.toString().padStart(2, '0')
  };
}

/**
 * Converts a number to Nepali words (for cheque writing, etc.)
 * Uses English number words with Nepali numbering units (Crore, Lakh, Thousand)
 * Note: App.tsx uses English words; src/utils/index.ts (older) uses Nepali words.
 * This version matches App.tsx behavior.
 */
export function numberToWordsNepali(num: number): string {
  if (num === 0) return 'Zero';
  
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  
  const convertLessThanThousand = (n: number): string => {
    if (n === 0) return '';
    if (n < 20) return ones[n];
    if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 !== 0 ? ' ' + ones[n % 10] : '');
    return ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 !== 0 ? ' ' + convertLessThanThousand(n % 100) : '');
  };
  
  const convertNepali = (n: number): string => {
    if (n === 0) return 'Zero';
    
    let result = '';
    
    if (n >= 10000000) {
      result += convertLessThanThousand(Math.floor(n / 10000000)) + ' Crore ';
      n %= 10000000;
    }
    if (n >= 100000) {
      result += convertLessThanThousand(Math.floor(n / 100000)) + ' Lakh ';
      n %= 100000;
    }
    if (n >= 1000) {
      result += convertLessThanThousand(Math.floor(n / 1000)) + ' Thousand ';
      n %= 1000;
    }
    if (n > 0) {
      result += convertLessThanThousand(n);
    }
    
    return result.trim();
  };
  
  const rupees = Math.floor(num);
  const paisa = Math.round((num - rupees) * 100);
  
  let words = convertNepali(rupees);
  
  if (paisa > 0) {
    words += ' and ' + convertLessThanThousand(paisa) + ' paisa';
  }
  
  return words + ' Only';
}

// ============ UNIT NORMALIZATION ============

const UNIT_NORMALIZATION: Record<string, string> = {
  'cum ': 'cum', 'cum': 'cum',
  'sqm': 'sqm', 'sq.m': 'sqm', 'Sq.m': 'sqm', 'SQ.M': 'sqm',
  'rm': 'rm', 'Rm': 'rm', 'RM': 'rm', 'r.m': 'rm',
  'nos.': 'nos', 'nos': 'nos', 'Nos': 'nos', 'NOS': 'nos',
  'no': 'no', 'No': 'no', 'NO': 'no',
  'kgs': 'kg', 'kg': 'kg', 'Kg': 'kg', 'KG': 'kg',
  'ps': 'ps', 'PS': 'ps', 'Ps': 'ps',
  'pc': 'pc', 'PC': 'pc', 'Pc': 'pc',
  'ltr': 'ltr', 'Ltr': 'ltr', 'LTR': 'ltr',
  'l': 'ltr', 'L': 'ltr',
  'm': 'm', 'M': 'm',
  'ton': 'ton', 'Ton': 'ton', 'TON': 'ton',
  'set': 'set', 'Set': 'set', 'SET': 'set',
  'pt': 'pt', 'Pt': 'pt', 'PT': 'pt',
  'one': 'one', 'One': 'one', 'ONE': 'one',
  'box': 'box', 'Box': 'box', 'BOX': 'box',
  'bag': 'bag', 'Bag': 'bag', 'BAG': 'bag',
  'dozen': 'dozen', 'Dozen': 'dozen', 'DOZEN': 'dozen',
  'pair': 'pair', 'Pair': 'pair', 'PAIR': 'pair'
};

export const STANDARD_UNITS = ['pc', 'nos', 'no', 'set', 'pt', 'cum', 'sqm', 'rm', 'm', 'kg', 'ton', 'ltr', 'PS', 'one', 'box', 'bag', 'dozen', 'pair'];

/** A standard paid day on site. Attendance, day rates and overtime all derive from it. */
export const STANDARD_WORK_HOURS = 8;

/**
 * Normalizes unit string to standard format
 */
export function normalizeUnit(unit: string): string {
  const trimmed = unit.trim();
  return UNIT_NORMALIZATION[trimmed] || trimmed;
}

// ============ DATE/TIME HELPERS ============

/**
 * Gets current date string in specified timezone (YYYY-MM-DD)
 */
export function getCurrentDateInTimezone(timezone: string): string {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    return formatter.format(now);
  } catch {
    return new Date().toISOString().split('T')[0];
  }
}

/**
 * Today in the app's home timezone. `new Date().toISOString().slice(0, 10)`
 * is the UTC date: in Nepal (UTC+5:45) that is still yesterday until 05:45,
 * so default document dates and as-of reports would land a day early.
 */
export function todayISOInKathmandu(): string {
  return getCurrentDateInTimezone('Asia/Kathmandu');
}

/**
 * Gets current month string in specified timezone (YYYY-MM)
 */
export function getCurrentMonthInTimezone(timezone: string): string {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit'
    });
    return formatter.format(now);
  } catch {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
}

// ============ DATE CONVERSION (BS <-> AD) ============
// These string-based helpers are kept for API compatibility, but all actual
// calendar math is delegated to ./nepaliDate (nepali-datetime lookup tables).

/**
 * Converts Bikram Sambat (BS) date to Gregorian (AD) date
 * BS format: YYYY/MM/DD  ->  AD format: YYYY-MM-DD
 */
export function bsToAd(bsDate: string): string {
  if (!bsDate || !/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(bsDate)) return '';

  const [bsYear, bsMonth, bsDay] = bsDate.split('/').map(Number);
  try {
    const adDate = bsToAD(bsYear, bsMonth, bsDay);

    // B.S. days start at Kathmandu midnight, so render the A.D. day in Kathmandu.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kathmandu',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(adDate);
  } catch {
    // Outside B.S. 1975-2100 there is no A.D. day; a blank beats a wrong one.
    return '';
  }
}

/**
 * Converts Gregorian (AD) date to Bikram Sambat (BS) date
 * AD format: YYYY-MM-DD  ->  BS format: YYYY/MM/DD
 */
export function adToBs(adDate: string): string {
  if (!adDate) return '';

  const date = new Date(adDate);
  if (isNaN(date.getTime())) return '';

  try {
    const bs = adToBS(date);
    return `${bs.year}/${String(bs.month).padStart(2, '0')}/${String(bs.day).padStart(2, '0')}`;
  } catch {
    // Outside A.D. 1918-04-13 .. 2044-04-12 there is no B.S. day.
    return '';
  }
}
