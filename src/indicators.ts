import type { Bar } from './types.js';

const nan = (n: number) => new Array<number>(n).fill(NaN);

export function sma(v: number[], p: number): number[] {
  const out = nan(v.length);
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    s += v[i];
    if (i >= p) s -= v[i - p];
    if (i >= p - 1) out[i] = s / p;
  }
  return out;
}

export function ema(v: number[], p: number): number[] {
  const out = nan(v.length);
  if (v.length < p) return out;
  const k = 2 / (p + 1);
  let e = 0;
  for (let i = 0; i < p; i++) e += v[i];
  e /= p;
  out[p - 1] = e;
  for (let i = p; i < v.length; i++) {
    e = v[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

export function bollinger(v: number[], p = 20, mult = 2): { mid: number[]; up: number[]; lo: number[] } {
  const mid = sma(v, p);
  const up = nan(v.length);
  const lo = nan(v.length);
  for (let i = p - 1; i < v.length; i++) {
    let s = 0;
    for (let j = i - p + 1; j <= i; j++) s += (v[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / p);
    up[i] = mid[i] + mult * sd;
    lo[i] = mid[i] - mult * sd;
  }
  return { mid, up, lo };
}

/** Wilder's RSI. */
export function rsi(v: number[], p = 14): number[] {
  const out = nan(v.length);
  if (v.length <= p) return out;
  let g = 0;
  let l = 0;
  for (let i = 1; i <= p; i++) {
    const d = v[i] - v[i - 1];
    if (d > 0) g += d;
    else l -= d;
  }
  g /= p;
  l /= p;
  out[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = p + 1; i < v.length; i++) {
    const d = v[i] - v[i - 1];
    g = (g * (p - 1) + Math.max(d, 0)) / p;
    l = (l * (p - 1) + Math.max(-d, 0)) / p;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

export function macd(v: number[], fast = 12, slow = 26, sig = 9): { macd: number[]; signal: number[]; hist: number[] } {
  const f = ema(v, fast);
  const s = ema(v, slow);
  const m = v.map((_, i) => f[i] - s[i]);
  const start = m.findIndex((x) => Number.isFinite(x));
  const signal = nan(v.length);
  if (start >= 0) {
    const tail = ema(m.slice(start), sig);
    for (let i = 0; i < tail.length; i++) signal[start + i] = tail[i];
  }
  const hist = m.map((x, i) => x - signal[i]);
  return { macd: m, signal, hist };
}

export const closes = (bars: Bar[]) => bars.map((b) => b.c);
