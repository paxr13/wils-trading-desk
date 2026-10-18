import { Bar, TF, TFS } from './types.js';
import { fmtAxis, fmtShortDate, MONTHS } from './format.js';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LineSpec {
  values: number[];
  color: string;
  width?: number;
  dash?: number[];
}

export interface SubPane {
  id: string;
  title: string;
  height: number;
  range?: [number, number];
  ticks?: number[];
  lines: LineSpec[];
  hist?: { values: number[]; colors: string[] };
  hlines?: { v: number; color: string; dash?: number[] }[];
  bands?: { from: number; to: number; color: string }[];
  digits?: number;
}

export interface DrawApi {
  ctx: CanvasRenderingContext2D;
  plot: Rect;
  bars: Bar[];
  tf: TF;
  from: number;
  to: number;
  spacing: number;
  log: boolean;
  x(i: number): number;
  iFromX(x: number): number;
  y(p: number): number;
  priceAt(y: number): number;
  idxAt(t: number): number;
  timeAt(i: number): number;
}

export interface Overlay {
  z: 'below' | 'above';
  draw(api: DrawApi): void;
}

export const THEME = {
  bg: '#d9d8d6',
  axisBg: '#ecebe9',
  text: '#202226',
  muted: '#6b6a68',
  grid: 'rgba(32,34,38,0.07)',
  border: '#b9b8b5',
  up: '#089981',
  down: '#f23645',
  cross: '#55565c',
  font: "500 10.5px 'IBM Plex Mono', ui-monospace, Menlo, monospace",
  fontBold: "600 10.5px 'IBM Plex Mono', ui-monospace, Menlo, monospace",
};

const AXIS_W = 68;
const TIME_H = 24;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

function niceStep(x: number): number {
  const e = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / e;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * e;
}

function addMonths(t: number, k: number): number {
  const d = new Date(t * 1000);
  d.setUTCMonth(d.getUTCMonth() + k);
  return d.getTime() / 1000;
}

type Drag = {
  x: number;
  y: number;
  right: number;
  spacing: number;
  manual: [number, number] | null;
  yr: [number, number];
  area: 'plot' | 'axis';
  moved: boolean;
  type: string;
};

export class Chart {
  private cv: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private W = 0;
  private H = 0;
  bars: Bar[] = [];
  tf: TF = '1w';
  log = true;
  volume = true;
  private spacing = 6;
  private right = 0;
  private viewPending = true;
  private manual: [number, number] | null = null;
  private yr: [number, number] = [0, 1];
  private lines: LineSpec[] = [];
  private overlays: Overlay[] = [];
  private panes: SubPane[] = [];
  private cross: { x: number; y: number } | null = null;
  private raf = 0;
  private ptrs = new Map<number, { x: number; y: number }>();
  private drag: Drag | null = null;
  private pinch: { d: number; midI: number; midX: number; spacing: number } | null = null;
  pickMode = false;
  onHover: (i: number | null) => void = () => {};
  onTap: (i: number, price: number) => void = () => {};

  constructor(private host: HTMLElement) {
    this.cv = document.createElement('canvas');
    this.cv.setAttribute('role', 'img');
    this.cv.setAttribute('aria-label', 'Price chart');
    this.cv.tabIndex = 0;
    host.appendChild(this.cv);
    const ctx = this.cv.getContext('2d');
    if (!ctx) throw new Error('Canvas not supported');
    this.ctx = ctx;
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.bindEvents();
    if (document.fonts) document.fonts.ready.then(() => this.redraw());
  }

  // ---------- public API ----------

  setBars(bars: Bar[], tf: TF, keepView = false): void {
    const prevN = this.bars.length;
    const atEnd = this.right >= prevN - 2;
    this.bars = bars;
    this.tf = tf;
    if (!keepView || !prevN) {
      this.viewPending = true;
    } else if (atEnd && bars.length > prevN) {
      this.right += bars.length - prevN;
    }
    this.redraw();
  }

  setLog(log: boolean): void {
    this.log = log;
    this.manual = null;
    this.redraw();
  }

  setLayers(lines: LineSpec[], overlays: Overlay[], panes: SubPane[], volume: boolean): void {
    this.lines = lines;
    this.overlays = overlays;
    this.panes = panes;
    this.volume = volume;
    this.redraw();
  }

  resetView(): void {
    this.viewPending = true;
    this.redraw();
  }

  get height(): number {
    return this.H;
  }

  redraw(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  // ---------- coordinates ----------

  private dur(): number {
    return TFS[this.tf].sec;
  }

  timeAt(i: number): number {
    const b = this.bars;
    const n = b.length;
    if (!n) return 0;
    if (i <= 0) return b[0].t + i * this.dur();
    if (i >= n - 1) {
      const k = i - (n - 1);
      if (this.tf === '1M') {
        const w = Math.floor(k);
        const t1 = addMonths(b[n - 1].t, w);
        return t1 + (k - w) * (addMonths(b[n - 1].t, w + 1) - t1);
      }
      return b[n - 1].t + k * this.dur();
    }
    const f = Math.floor(i);
    return b[f].t + (i - f) * (b[f + 1].t - b[f].t);
  }

  idxAt(t: number): number {
    const b = this.bars;
    const n = b.length;
    if (!n) return 0;
    if (t <= b[0].t) return (t - b[0].t) / this.dur();
    const last = b[n - 1].t;
    if (t >= last) {
      if (this.tf === '1M') {
        const a = new Date(last * 1000);
        const d = new Date(t * 1000);
        const w = (d.getUTCFullYear() - a.getUTCFullYear()) * 12 + d.getUTCMonth() - a.getUTCMonth();
        const t1 = addMonths(last, w);
        const t2 = addMonths(last, w + 1);
        return n - 1 + w + (t - t1) / (t2 - t1);
      }
      return n - 1 + (t - last) / this.dur();
    }
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (b[m].t <= t) lo = m;
      else hi = m;
    }
    return lo + (t - b[lo].t) / (b[hi].t - b[lo].t);
  }

  private layout() {
    const plotW = Math.max(40, this.W - AXIS_W);
    const sub = this.panes.reduce((s, p) => s + p.height, 0);
    const mainH = Math.max(90, this.H - TIME_H - sub);
    const main: Rect = { x: 0, y: 0, w: plotW, h: mainH };
    let y = mainH;
    const panes = this.panes.map((p) => {
      const r: Rect = { x: 0, y, w: plotW, h: p.height };
      y += p.height;
      return { p, r };
    });
    return { plotW, main, panes, timeY: y };
  }

  private x(i: number, plotW: number): number {
    return plotW + (i - this.right) * this.spacing;
  }

  private tr(p: number): number {
    return this.log ? Math.log(Math.max(p, 1e-12)) : p;
  }

  private inv(v: number): number {
    return this.log ? Math.exp(v) : v;
  }

  // ---------- view ----------

  private defaultView(plotW: number): void {
    const n = this.bars.length;
    if (!n) return;
    const count = Math.max(8, Math.min(n, TFS[this.tf].defaultBars, Math.floor(plotW / 1.3)));
    const fut = 0.12;
    this.spacing = clamp((plotW * (1 - fut)) / count, 0.3, 40);
    this.right = n - 1 + (plotW * fut) / this.spacing;
    this.manual = null;
    this.viewPending = false;
  }

  private clampView(plotW: number): void {
    const n = this.bars.length;
    this.spacing = clamp(this.spacing, 0.3, 60);
    const vis = plotW / this.spacing;
    this.right = clamp(this.right, Math.min(n - 1, 4), n - 1 + vis * 0.85);
  }

  private autoRange(from: number, to: number): [number, number] {
    const b = this.bars;
    let lo = Infinity;
    let hi = -Infinity;
    const a = Math.max(0, Math.ceil(from));
    const z = Math.min(b.length - 1, Math.floor(to));
    for (let i = a; i <= z; i++) {
      if (b[i].l < lo) lo = b[i].l;
      if (b[i].h > hi) hi = b[i].h;
    }
    if (!Number.isFinite(lo)) {
      const last = b[b.length - 1];
      lo = last ? last.l : 1;
      hi = last ? last.h : 2;
    }
    let tlo = this.tr(lo);
    let thi = this.tr(hi);
    if (thi - tlo < 1e-9) {
      thi += Math.abs(thi) * 0.01 + 1e-6;
      tlo -= Math.abs(tlo) * 0.01 + 1e-6;
    }
    const r = thi - tlo;
    return [tlo - r * (this.volume ? 0.24 : 0.08), thi + r * 0.08];
  }

  // ---------- drawing ----------

  private resize(): void {
    const r = this.host.getBoundingClientRect();
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.W = Math.max(50, Math.floor(r.width));
    this.H = Math.max(120, Math.floor(r.height));
    this.cv.width = Math.round(this.W * this.dpr);
    this.cv.height = Math.round(this.H * this.dpr);
    this.cv.style.width = this.W + 'px';
    this.cv.style.height = this.H + 'px';
    this.redraw();
  }

  private api(main: Rect, from: number, to: number): DrawApi {
    const plotW = main.w;
    const [lo, hi] = this.yr;
    return {
      ctx: this.ctx,
      plot: main,
      bars: this.bars,
      tf: this.tf,
      from,
      to,
      spacing: this.spacing,
      log: this.log,
      x: (i) => this.x(i, plotW),
      iFromX: (x) => this.right + (x - plotW) / this.spacing,
      y: (p) => main.y + ((hi - this.tr(p)) / (hi - lo)) * main.h,
      priceAt: (y) => this.inv(hi - ((y - main.y) / main.h) * (hi - lo)),
      idxAt: (t) => this.idxAt(t),
      timeAt: (i) => this.timeAt(i),
    };
  }

  private draw(): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);
    const L = this.layout();
    const { plotW, main } = L;
    ctx.fillStyle = THEME.axisBg;
    ctx.fillRect(0, 0, this.W, this.H);
    ctx.fillStyle = THEME.bg;
    ctx.fillRect(0, 0, plotW, L.timeY);
    if (!this.bars.length) return;

    if (this.viewPending) this.defaultView(plotW);
    this.clampView(plotW);
    const from = this.right - plotW / this.spacing;
    const to = this.right;
    this.yr = this.manual ?? this.autoRange(from, to);
    const api = this.api(main, from, to);

    // grid + time ticks
    const ticks = this.timeTicks(from, to, plotW);
    ctx.fillStyle = THEME.grid;
    for (const t of ticks) ctx.fillRect(Math.round(t.x), 0, 1, L.timeY);
    const pticks = this.priceTicks(this.yr[0], this.yr[1], main.h);
    for (const p of pticks) ctx.fillRect(0, Math.round(api.y(p)), plotW, 1);

    // main pane
    ctx.save();
    ctx.beginPath();
    ctx.rect(main.x, main.y, main.w, main.h);
    ctx.clip();
    for (const o of this.overlays) if (o.z === 'below') this.safe(() => o.draw(api));
    if (this.volume) this.drawVolume(api, from, to);
    this.drawCandles(api, from, to);
    for (const l of this.lines) this.drawLine(l, api.x, api.y, from, to, this.log);
    for (const o of this.overlays) if (o.z === 'above') this.safe(() => o.draw(api));
    ctx.restore();

    // sub panes
    for (const { p, r } of L.panes) this.drawPane(p, r, from, to, plotW);

    // price axis (main)
    ctx.font = THEME.font;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = THEME.text;
    for (const p of pticks) {
      const y = api.y(p);
      if (y < 8 || y > main.h - 6) continue;
      ctx.fillText(fmtAxis(p), plotW + 8, y);
    }

    // time axis
    ctx.textAlign = 'center';
    for (const t of ticks) {
      ctx.font = t.major ? THEME.fontBold : THEME.font;
      ctx.fillText(t.text, t.x, L.timeY + TIME_H / 2 + 1);
    }

    // last price
    const last = this.bars[this.bars.length - 1];
    const ly = api.y(last.c);
    const lcol = last.c >= last.o ? THEME.up : THEME.down;
    if (ly > 0 && ly < main.h) {
      ctx.strokeStyle = lcol;
      ctx.setLineDash([2, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(ly) + 0.5);
      ctx.lineTo(plotW, Math.round(ly) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      this.axisTag(plotW, ly, fmtAxis(last.c), lcol);
    }

    // separators and frame
    ctx.fillStyle = THEME.border;
    for (const { r } of L.panes) ctx.fillRect(0, r.y, this.W, 1);
    ctx.fillRect(plotW, 0, 1, L.timeY);
    ctx.fillRect(0, L.timeY, this.W, 1);

    this.drawCross(L, api);
  }

  private safe(fn: () => void): void {
    this.ctx.save();
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
    this.ctx.restore();
  }

  private drawCandles(api: DrawApi, from: number, to: number): void {
    const ctx = this.ctx;
    const b = this.bars;
    const a = Math.max(0, Math.floor(from));
    const z = Math.min(b.length - 1, Math.ceil(to));
    const bw = Math.max(1, Math.round(this.spacing * 0.68));
    const thin = this.spacing < 2.2;
    for (let i = a; i <= z; i++) {
      const k = b[i];
      const x = Math.round(api.x(i));
      const up = k.c >= k.o;
      ctx.fillStyle = up ? THEME.up : THEME.down;
      const yh = api.y(k.h);
      const yl = api.y(k.l);
      ctx.fillRect(x, yh, 1, Math.max(1, yl - yh));
      if (thin) continue;
      const yo = api.y(k.o);
      const yc = api.y(k.c);
      const top = Math.min(yo, yc);
      const h = Math.max(1, Math.abs(yo - yc));
      ctx.fillRect(x - Math.floor(bw / 2), top, bw, h);
    }
  }

  private drawVolume(api: DrawApi, from: number, to: number): void {
    const ctx = this.ctx;
    const b = this.bars;
    const a = Math.max(0, Math.floor(from));
    const z = Math.min(b.length - 1, Math.ceil(to));
    let max = 0;
    for (let i = a; i <= z; i++) max = Math.max(max, b[i].v);
    if (!max) return;
    const base = api.plot.y + api.plot.h;
    const hMax = api.plot.h * 0.16;
    const bw = Math.max(1, Math.round(this.spacing * 0.68));
    ctx.globalAlpha = 0.32;
    for (let i = a; i <= z; i++) {
      const k = b[i];
      const h = (k.v / max) * hMax;
      ctx.fillStyle = k.c >= k.o ? THEME.up : THEME.down;
      ctx.fillRect(Math.round(api.x(i)) - Math.floor(bw / 2), base - h, bw, h);
    }
    ctx.globalAlpha = 1;
  }

  private drawLine(l: LineSpec, xf: (i: number) => number, yf: (v: number) => number, from: number, to: number, positiveOnly = false): void {
    const ctx = this.ctx;
    const a = Math.max(0, Math.floor(from) - 1);
    const z = Math.min(l.values.length - 1, Math.ceil(to) + 1);
    ctx.strokeStyle = l.color;
    ctx.lineWidth = l.width ?? 1.4;
    ctx.setLineDash(l.dash ?? []);
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let pen = false;
    for (let i = a; i <= z; i++) {
      const v = l.values[i];
      if (!Number.isFinite(v) || (positiveOnly && v <= 0)) {
        pen = false;
        continue;
      }
      const x = xf(i);
      const y = yf(v);
      if (pen) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      pen = true;
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private paneRange(p: SubPane, from: number, to: number): [number, number] {
    if (p.range) return p.range;
    let lo = Infinity;
    let hi = -Infinity;
    const a = Math.max(0, Math.floor(from));
    const z = Math.min(this.bars.length - 1, Math.ceil(to));
    const take = (arr: number[]) => {
      for (let i = a; i <= z; i++) {
        const v = arr[i];
        if (Number.isFinite(v)) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
    };
    p.lines.forEach((l) => take(l.values));
    if (p.hist) take(p.hist.values);
    if (!Number.isFinite(lo)) return [0, 1];
    if (hi - lo < 1e-12) {
      hi += 1;
      lo -= 1;
    }
    const pad = (hi - lo) * 0.1;
    return [lo - pad, hi + pad];
  }

  private drawPane(p: SubPane, r: Rect, from: number, to: number, plotW: number): void {
    const ctx = this.ctx;
    const [lo, hi] = this.paneRange(p, from, to);
    const top = r.y + 14;
    const h = r.h - 18;
    const yf = (v: number) => top + ((hi - v) / (hi - lo)) * h;
    const xf = (i: number) => this.x(i, plotW);
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    for (const b of p.bands ?? []) {
      ctx.fillStyle = b.color;
      const y1 = yf(b.to);
      const y2 = yf(b.from);
      ctx.fillRect(0, y1, plotW, y2 - y1);
    }
    for (const hl of p.hlines ?? []) {
      ctx.strokeStyle = hl.color;
      ctx.setLineDash(hl.dash ?? [3, 3]);
      ctx.lineWidth = 1;
      const y = Math.round(yf(hl.v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(plotW, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (p.hist) {
      const bw = Math.max(1, Math.round(this.spacing * 0.6));
      const y0 = yf(0);
      const a = Math.max(0, Math.floor(from));
      const z = Math.min(p.hist.values.length - 1, Math.ceil(to));
      for (let i = a; i <= z; i++) {
        const v = p.hist.values[i];
        if (!Number.isFinite(v)) continue;
        ctx.fillStyle = p.hist.colors[i] ?? THEME.muted;
        const y = yf(v);
        ctx.fillRect(Math.round(xf(i)) - Math.floor(bw / 2), Math.min(y, y0), bw, Math.max(1, Math.abs(y - y0)));
      }
    }
    for (const l of p.lines) this.drawLine(l, xf, yf, from, to);
    // title + latest value
    ctx.font = THEME.font;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = THEME.text;
    const vals = p.lines
      .map((l) => {
        for (let i = Math.min(l.values.length - 1, Math.floor(to)); i >= 0; i--) {
          if (Number.isFinite(l.values[i])) return l.values[i];
        }
        return NaN;
      })
      .filter(Number.isFinite)
      .map((v) => v.toFixed(p.digits ?? 2));
    ctx.fillText(`${p.title}  ${vals.join('  ')}`, 6, r.y + 9);
    ctx.restore();
    // axis ticks
    ctx.font = THEME.font;
    ctx.fillStyle = THEME.text;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const ticks = p.ticks ?? this.linTicks(lo, hi, h, 26);
    for (const v of ticks) {
      const y = yf(v);
      if (y < r.y + 6 || y > r.y + r.h - 4) continue;
      ctx.fillText(v.toFixed(Math.abs(v) >= 100 || p.range ? 0 : (p.digits ?? 2)), plotW + 8, y);
    }
  }

  private axisTag(plotW: number, y: number, text: string, color: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.fillRect(plotW + 1, Math.round(y) - 8, AXIS_W - 2, 16);
    ctx.fillStyle = '#fff';
    ctx.font = THEME.fontBold;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, plotW + 7, Math.round(y) + 0.5);
  }

  private drawCross(L: ReturnType<Chart['layout']>, api: DrawApi): void {
    if (!this.cross) return;
    const ctx = this.ctx;
    const { plotW, main } = L;
    const n = this.bars.length;
    const i = clamp(Math.round(api.iFromX(this.cross.x)), 0, n - 1);
    const x = Math.round(api.x(i)) + 0.5;
    const y = this.cross.y;
    ctx.strokeStyle = THEME.cross;
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, L.timeY);
    if (y >= 0 && y <= L.timeY) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(plotW, Math.round(y) + 0.5);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    // price label in the pane under the pointer
    if (y >= 0 && y < main.h) {
      const [lo, hi] = this.yr;
      const p = this.inv(hi - ((y - main.y) / main.h) * (hi - lo));
      this.axisTag(plotW, y, fmtAxis(p), '#202226');
    }
    const label = fmtShortDate(this.bars[i].t, this.tf);
    ctx.font = THEME.font;
    const w = ctx.measureText(label).width + 12;
    ctx.fillStyle = '#202226';
    const lx = clamp(x - w / 2, 0, plotW - w);
    ctx.fillRect(lx, L.timeY + 1, w, TIME_H - 1);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, lx + w / 2, L.timeY + TIME_H / 2 + 1);
  }

  // ---------- ticks ----------

  private timeTicks(from: number, to: number, plotW: number): { x: number; text: string; major: boolean }[] {
    const barSec = this.dur();
    const units = [
      { k: 'day', sec: 86400 },
      { k: 'week', sec: 604800 },
      { k: 'month', sec: 2629746 },
      { k: 'quarter', sec: 7889238 },
      { k: 'year', sec: 31556952 },
      { k: '2year', sec: 63113904 },
      { k: '5year', sec: 157784760 },
    ];
    let unit = units[units.length - 1];
    for (const u of units) {
      if (u.sec < barSec * 0.99) continue;
      if ((this.spacing * u.sec) / barSec >= 64) {
        unit = u;
        break;
      }
    }
    const key = (t: number) => {
      const d = new Date(t * 1000);
      const Y = d.getUTCFullYear();
      const M = d.getUTCMonth();
      switch (unit.k) {
        case 'day':
          return Y * 400 + M * 32 + d.getUTCDate();
        case 'week':
          return Math.floor((t / 86400 + 3) / 7); // Monday-start weeks

        case 'month':
          return Y * 12 + M;
        case 'quarter':
          return Y * 4 + Math.floor(M / 3);
        case 'year':
          return Y;
        case '2year':
          return Math.floor(Y / 2);
        default:
          return Math.floor(Y / 5);
      }
    };
    const out: { x: number; text: string; major: boolean }[] = [];
    let i0 = Math.floor(from);
    let prevT = this.timeAt(i0 - 1);
    let prev = key(prevT);
    let lastX = -1e9;
    for (let i = i0; i <= Math.ceil(to); i++) {
      const t = this.timeAt(i);
      const k = key(t);
      if (k !== prev) {
        const d = new Date(t * 1000);
        const pd = new Date(prevT * 1000);
        const yearChange = d.getUTCFullYear() !== pd.getUTCFullYear();
        const monthChange = yearChange || d.getUTCMonth() !== pd.getUTCMonth();
        const x = this.x(i, plotW);
        let text: string;
        let major = false;
        if (yearChange) {
          text = String(d.getUTCFullYear());
          major = true;
        } else if ((unit.k === 'day' || unit.k === 'week') && !monthChange) {
          text = String(d.getUTCDate());
        } else {
          text = MONTHS[d.getUTCMonth()];
        }
        if (x - lastX < 44) {
          if (major && out.length && !out[out.length - 1].major) {
            out.pop();
          } else {
            prev = k;
            prevT = t;
            continue;
          }
        }
        if (x > 12 && x < plotW - 12) {
          out.push({ x, text, major });
          lastX = x;
        }
        prev = k;
      }
      prevT = t;
    }
    return out;
  }

  private linTicks(lo: number, hi: number, h: number, px: number): number[] {
    const step = niceStep((hi - lo) / Math.max(2, h / px));
    const out: number[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(+v.toPrecision(12));
    return out;
  }

  private priceTicks(lo: number, hi: number, h: number): number[] {
    if (!this.log) return this.linTicks(lo, hi, h, 42);
    const pLo = Math.exp(lo);
    const pHi = Math.exp(hi);
    const e0 = Math.floor(Math.log10(pLo)) - 1;
    const e1 = Math.ceil(Math.log10(pHi)) + 1;
    const sets = [[1, 1.2, 1.4, 1.6, 1.8, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9], [1, 1.5, 2, 3, 4, 5, 6, 7, 8, 9], [1, 1.5, 2, 3, 5, 7], [1, 2, 5], [1, 3], [1]];
    const pxPer = h / (hi - lo);
    for (const set of sets) {
      const t: number[] = [];
      for (let e = e0; e <= e1; e++) for (const m of set) {
        const v = +(m * Math.pow(10, e)).toPrecision(6);
        if (v >= pLo && v <= pHi) t.push(v);
      }
      let ok = t.length > 0;
      for (let k = 1; k < t.length && ok; k++) if ((Math.log(t[k]) - Math.log(t[k - 1])) * pxPer < 30) ok = false;
      if (ok && t.length >= 2) return t;
    }
    const t: number[] = [];
    const step = Math.max(1, Math.ceil((30 / pxPer) / Math.log(10)));
    for (let e = e0; e <= e1; e += step) {
      const v = Math.pow(10, e);
      if (v >= pLo && v <= pHi) t.push(v);
    }
    return t;
  }

  // ---------- interaction ----------

  private pos(e: { clientX: number; clientY: number }) {
    const r = this.cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private bindEvents(): void {
    const cv = this.cv;
    cv.style.touchAction = 'none';

    cv.addEventListener('pointerdown', (e) => {
      const p = this.pos(e);
      cv.setPointerCapture(e.pointerId);
      this.ptrs.set(e.pointerId, p);
      const plotW = this.layout().plotW;
      if (this.ptrs.size === 2) {
        const [a, b] = [...this.ptrs.values()];
        const midX = (a.x + b.x) / 2;
        this.pinch = {
          d: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          midX,
          midI: this.right + (midX - plotW) / this.spacing,
          spacing: this.spacing,
        };
        this.drag = null;
        return;
      }
      this.drag = {
        x: p.x,
        y: p.y,
        right: this.right,
        spacing: this.spacing,
        manual: this.manual,
        yr: [...this.yr] as [number, number],
        area: p.x > plotW ? 'axis' : 'plot',
        moved: false,
        type: e.pointerType,
      };
    });

    cv.addEventListener('pointermove', (e) => {
      const p = this.pos(e);
      if (this.ptrs.has(e.pointerId)) this.ptrs.set(e.pointerId, p);
      const L = this.layout();
      if (this.pinch && this.ptrs.size >= 2) {
        const [a, b] = [...this.ptrs.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        this.spacing = clamp((this.pinch.spacing * d) / this.pinch.d, 0.3, 60);
        const midX = (a.x + b.x) / 2;
        this.right = this.pinch.midI - (midX - L.plotW) / this.spacing;
        this.redraw();
        return;
      }
      const g = this.drag;
      if (g) {
        const dx = p.x - g.x;
        const dy = p.y - g.y;
        if (!g.moved && Math.hypot(dx, dy) > 5) g.moved = true;
        if (!g.moved) return;
        if (g.area === 'axis') {
          const base = g.manual ?? g.yr;
          const c = (base[0] + base[1]) / 2;
          const half = ((base[1] - base[0]) / 2) * Math.exp(dy * 0.006);
          this.manual = [c - half, c + half];
        } else {
          this.right = g.right - dx / this.spacing;
          if (g.manual) {
            const shift = (dy / L.main.h) * (g.manual[1] - g.manual[0]);
            this.manual = [g.manual[0] + shift, g.manual[1] + shift];
          }
          if (g.type !== 'mouse') this.cross = null;
        }
        this.redraw();
        if (g.type === 'mouse') this.hoverAt(p);
        return;
      }
      if (e.pointerType === 'mouse') this.hoverAt(p);
    });

    const end = (e: PointerEvent) => {
      this.ptrs.delete(e.pointerId);
      if (this.ptrs.size < 2) this.pinch = null;
      const g = this.drag;
      this.drag = null;
      if (!g || g.moved || e.type === 'pointercancel') return;
      const p = this.pos(e);
      const L = this.layout();
      if (p.x > L.plotW) return;
      const n = this.bars.length;
      const i = clamp(Math.round(this.right + (p.x - L.plotW) / this.spacing), 0, n - 1);
      if (this.pickMode && p.y < L.main.h) {
        const [lo, hi] = this.yr;
        this.onTap(i, this.inv(hi - (p.y / L.main.h) * (hi - lo)));
        return;
      }
      if (e.pointerType !== 'mouse') {
        if (this.cross && Math.abs(this.cross.x - p.x) < 4) {
          this.cross = null;
          this.onHover(null);
        } else this.hoverAt(p);
        this.redraw();
      }
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);

    cv.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !this.drag) {
        this.cross = null;
        this.onHover(null);
        this.redraw();
      }
    });

    cv.addEventListener('dblclick', (e) => {
      const p = this.pos(e);
      if (p.x > this.layout().plotW) this.manual = null;
      else this.viewPending = true;
      this.redraw();
    });

    cv.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const p = this.pos(e);
        const plotW = this.layout().plotW;
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          this.right += e.deltaX / this.spacing;
        } else {
          const i = this.right + (Math.min(p.x, plotW) - plotW) / this.spacing;
          const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
          this.spacing = clamp(this.spacing * f, 0.3, 60);
          this.right = i - (Math.min(p.x, plotW) - plotW) / this.spacing;
        }
        this.redraw();
      },
      { passive: false },
    );

    cv.addEventListener('keydown', (e) => {
      const step = Math.max(1, 40 / this.spacing);
      if (e.key === 'ArrowLeft') this.right -= step;
      else if (e.key === 'ArrowRight') this.right += step;
      else if (e.key === '+' || e.key === '=') this.spacing *= 1.15;
      else if (e.key === '-') this.spacing /= 1.15;
      else return;
      e.preventDefault();
      this.redraw();
    });
  }

  private hoverAt(p: { x: number; y: number }): void {
    const L = this.layout();
    const n = this.bars.length;
    if (!n || p.x > L.plotW) {
      this.cross = null;
      this.onHover(null);
    } else {
      this.cross = p;
      this.onHover(clamp(Math.round(this.right + (p.x - L.plotW) / this.spacing), 0, n - 1));
    }
    this.redraw();
  }
}
