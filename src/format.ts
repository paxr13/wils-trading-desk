import type { TF } from './types.js';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTHS = MON;

export function fmtPrice(p: number): string {
  if (!Number.isFinite(p)) return '–';
  const a = Math.abs(p);
  if (a >= 10000) return p.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (a >= 1000) return p.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (a >= 100) return p.toFixed(2);
  if (a >= 1) return p.toFixed(3);
  if (a === 0) return '0';
  // 4 significant digits for small prices
  const d = Math.min(10, 3 - Math.floor(Math.log10(a)));
  return p.toFixed(d);
}

/** Axis label: shorter than fmtPrice for big numbers. */
export function fmtAxis(p: number): string {
  const a = Math.abs(p);
  if (a >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return fmtPrice(p);
}

export function fmtPct(x: number, digits = 1): string {
  if (!Number.isFinite(x)) return '–';
  const s = x >= 0 ? '+' : '−';
  return s + Math.abs(x).toFixed(digits) + '%';
}

export function fmtDate(t: number, tf?: TF): string {
  const d = new Date(t * 1000);
  const base = `${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  if (tf === '4h') return `${base} ${String(d.getUTCHours()).padStart(2, '0')}:00 UTC`;
  if (tf === '1M') return `${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return base;
}

export function fmtShortDate(t: number, tf?: TF): string {
  const d = new Date(t * 1000);
  const y = String(d.getUTCFullYear()).slice(2);
  if (tf === '1M') return `${MON[d.getUTCMonth()]} '${y}`;
  const base = `${MON[d.getUTCMonth()]} ${d.getUTCDate()} '${y}`;
  if (tf === '4h') return `${base} ${String(d.getUTCHours()).padStart(2, '0')}:00`;
  return base;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}
