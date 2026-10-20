import type { Cents, ISODate } from './types';

/** Round a quantity to 3 decimal places to absorb floating-point noise. */
export function roundQty(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function sumQty(values: number[]): number {
  return roundQty(values.reduce((a, b) => a + b, 0));
}

/**
 * Parse a user-entered money amount ("12.50", "12,50", "R 1 200") into cents.
 * Returns null when the input is not a valid non-negative amount.
 */
export function parseMoney(input: string): Cents | null {
  const cleaned = input.replace(/[R\s ]/gi, '').replace(',', '.');
  if (cleaned === '' || !/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  return Math.round(parseFloat(cleaned) * 100);
}

/** Parse a quantity. Returns null when invalid. */
export function parseQty(input: string): number | null {
  const cleaned = input.trim().replace(',', '.');
  if (cleaned === '' || !/^-?\d+(\.\d{0,3})?$/.test(cleaned)) return null;
  return roundQty(parseFloat(cleaned));
}

export function centsToInput(c: Cents): string {
  return (c / 100).toFixed(2);
}

const formatterCache = new Map<string, Intl.NumberFormat>();

export function formatMoney(cents: Cents, currency: string, locale: string): string {
  const key = `${locale}|${currency}`;
  let f = formatterCache.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat(locale, { style: 'currency', currency });
    } catch {
      f = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' });
    }
    formatterCache.set(key, f);
  }
  return f.format(cents / 100);
}

export function formatQty(n: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(n);
}

/** Today's business date in local time. */
export function todayISO(now: Date = new Date()): ISODate {
  return toISODate(now);
}

export function toISODate(d: Date): ISODate {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(date: ISODate, days: number): ISODate {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return toISODate(dt);
}

export function formatDate(date: ISODate, locale: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(
    new Date(y, m - 1, d),
  );
}

export function isValidISODate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

export function inRange(date: ISODate, from: ISODate | '', to: ISODate | ''): boolean {
  return (!from || date >= from) && (!to || date <= to);
}
