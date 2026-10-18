import type { Bar, Pt } from './types.js';

export type Preset = 'last' | 'all' | 'latest' | 'custom';

export const PRESETS: { k: Preset; label: string; desc: string }[] = [
  { k: 'last', label: 'Last cycle', desc: 'All-time low to the biggest cycle high other than the all-time high' },
  { k: 'all', label: 'All-time', desc: 'All-time low to the all-time high' },
  { k: 'latest', label: 'Latest cycle', desc: 'Most recent major low to the highest point since' },
  { k: 'custom', label: 'Custom', desc: 'Your own low and high' },
];

export interface Anchors {
  o: Pt; // origin low
  h: Pt; // point the 1x1 runs through
  preset: Preset;
  note?: string;
}

/** Fan angles as multiples of the 1x1 slope (log price per unit time). */
export const FAN: { r: number; label: string; color: string; w?: number }[] = [
  { r: 3, label: '3x1', color: '#a898dd' },
  { r: 2.5, label: '5x2', color: '#8a74d6' },
  { r: 2, label: '2x1', color: '#3d5bf0' },
  { r: 1.5, label: '3x2', color: '#1f9a89' },
  { r: 1, label: '1x1', color: '#11806f', w: 1.8 },
  { r: 1 / 2, label: '1x2', color: '#4caf50' },
  { r: 1 / 4, label: '1x4', color: '#1fa8c4' },
  { r: 1 / 6, label: '1x6', color: '#ef9a2e' },
  { r: 1 / 8, label: '1x8', color: '#d9821c' },
  { r: 1 / 10, label: '1x10', color: '#6f6f6f' },
  { r: 1 / 12, label: '1x12', color: '#e5384f' },
  { r: 1 / 16, label: '1x16', color: '#a898dd' },
];

/**
 * Arcs are quarter-ellipses centred on the origin. Height is a multiple of the low-to-high
 * range in log price; width is that height stretched by ARC_STRETCH in 1x1 time units.
 */
export const ARCS: { m: number; color: string }[] = [
  { m: 0.75, color: '#ef9a2e' },
  { m: 1, color: '#ef9a2e' },
  { m: 1.125, color: '#ef9a2e' },
  { m: 1.5, color: '#1fa8c4' },
  { m: 1.75, color: '#1fa8c4' },
];
export const ARC_STRETCH = 2;
/** Arcs whose tops and end get level lines. */
export const LEVEL_ARCS = [0.75, 1.5];

const WEEK = 604800;

/** Group daily bars into Monday-start UTC weeks (the same buckets Binance uses). */
export function toWeekly(daily: Bar[]): Bar[] {
  const out: Bar[] = [];
  for (const d of daily) {
    const dow = (new Date(d.t * 1000).getUTCDay() + 6) % 7;
    const ws = d.t - dow * 86400;
    const last = out[out.length - 1];
    if (last && last.t === ws) {
      last.h = Math.max(last.h, d.h);
      last.l = Math.min(last.l, d.l);
      last.c = d.c;
      last.v += d.v;
    } else {
      out.push({ t: ws, o: d.o, h: d.h, l: d.l, c: d.c, v: d.v });
    }
  }
  return out;
}

/** Bars that are the highest high within `w` bars on both sides (needs the full right side). */
export function pivotHighs(b: Bar[], w: number): number[] {
  const out: number[] = [];
  for (let i = w; i + w < b.length; i++) {
    let ok = true;
    for (let j = i - w; j <= i + w && ok; j++) {
      if (j < i && b[j].h >= b[i].h) ok = false;
      if (j > i && b[j].h > b[i].h) ok = false;
    }
    if (ok) out.push(i);
  }
  return out;
}

export function pivotLows(b: Bar[], w: number): number[] {
  const out: number[] = [];
  for (let i = w; i + w < b.length; i++) {
    let ok = true;
    for (let j = i - w; j <= i + w && ok; j++) {
      if (j < i && b[j].l <= b[i].l) ok = false;
      if (j > i && b[j].l < b[i].l) ok = false;
    }
    if (ok) out.push(i);
  }
  return out;
}

function argMax(b: Bar[], from: number, to: number): number {
  let k = -1;
  for (let i = Math.max(0, from); i <= Math.min(b.length - 1, to); i++) if (k < 0 || b[i].h > b[k].h) k = i;
  return k;
}

function argMin(b: Bar[], from: number, to: number): number {
  let k = -1;
  for (let i = Math.max(0, from); i <= Math.min(b.length - 1, to); i++) if (k < 0 || b[i].l < b[k].l) k = i;
  return k;
}

/** Exact day of a weekly extreme, so anchors land on the right candle in daily and 4H views. */
function dayOf(daily: Bar[], weekStart: number, price: number, high: boolean): number {
  for (const d of daily) {
    if (d.t < weekStart) continue;
    if (d.t >= weekStart + WEEK) break;
    if ((high ? d.h : d.l) === price) return d.t;
  }
  return weekStart;
}

/** Pick anchors automatically from daily history using confirmed weekly pivots. */
export function autoAnchors(daily: Bar[], preset: Exclude<Preset, 'custom'>): Anchors | null {
  const W = toWeekly(daily);
  if (W.length < 12) return null;
  const mk = (oi: number, hi: number, p: Preset, note?: string): Anchors => ({
    o: { t: dayOf(daily, W[oi].t, W[oi].l, false), p: W[oi].l },
    h: { t: dayOf(daily, W[hi].t, W[hi].h, true), p: W[hi].h },
    preset: p,
    note,
  });
  const ath = argMax(W, 0, W.length - 1);

  const allTime = (note?: string): Anchors | null => {
    if (ath < 4) return null;
    return mk(argMin(W, 0, ath - 1), ath, 'all', note);
  };

  if (preset === 'all') return allTime();

  if (preset === 'last') {
    const highs = pivotHighs(W, 52).filter((i) => i !== ath && W[i].h < W[ath].h);
    const hi = highs.length ? highs[highs.length - 1] : -1;
    if (hi < 4) return allTime('No confirmed cycle high besides the all-time high yet, so this shows the all-time fan.');
    return mk(argMin(W, 0, hi - 1), hi, 'last');
  }

  // latest cycle: most recent low that is the lowest point 26 weeks either side
  const lows = pivotLows(W, 26);
  for (let k = lows.length - 1; k >= 0; k--) {
    const oi = lows[k];
    const hi = argMax(W, oi + 1, W.length - 1);
    if (hi - oi >= 4 && W[hi].h > W[oi].l) {
      return mk(oi, hi, 'latest', 'The 1x1 runs through the highest point since this low, so it moves if price makes a new high.');
    }
  }
  const fb = autoAnchors(daily, 'last');
  return fb ? { ...fb, note: 'No confirmed major low yet, so this shows the last-cycle fan.' } : null;
}

/** 1x1 slope in log price per second. */
export function slope(a: Anchors): number {
  return Math.log(a.h.p / a.o.p) / (a.h.t - a.o.t);
}

export function fanPrice(a: Anchors, r: number, t: number): number {
  return a.o.p * Math.exp(r * slope(a) * (t - a.o.t));
}

export function arcPoint(a: Anchors, m: number, theta: number): Pt {
  const D = Math.log(a.h.p / a.o.p);
  const B = slope(a);
  const v = m * D * Math.sin(theta);
  const u = ARC_STRETCH * m * D * Math.cos(theta);
  return { t: a.o.t + u / B, p: a.o.p * Math.exp(v) };
}

export function arcTop(a: Anchors, m: number): number {
  return a.o.p * Math.exp(m * Math.log(a.h.p / a.o.p));
}

export function arcEnd(a: Anchors, m: number): number {
  return a.o.t + (ARC_STRETCH * m * Math.log(a.h.p / a.o.p)) / slope(a);
}

export function validAnchors(a: { o: Pt; h: Pt } | null | undefined): boolean {
  return !!a && a.h.t > a.o.t && a.h.p > a.o.p && a.o.p > 0;
}
