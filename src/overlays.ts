import type { DrawApi, Overlay } from './chart.js';
import { THEME } from './chart.js';
import type { Pt } from './types.js';
import { Anchors, ARCS, FAN, LEVEL_ARCS, Pivot, Projection, arcEnd, arcPoint, arcTop, clusterProjections, fanPrice } from './gann.js';
import { moonPhases } from './moon.js';
import { fmtAxis, fmtShortDate } from './format.js';

function tag(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string, align: 'left' | 'right' = 'right'): void {
  ctx.font = THEME.font;
  const w = ctx.measureText(text).width + 8;
  const bx = align === 'right' ? x - w : x;
  ctx.fillStyle = 'rgba(236,235,233,0.88)';
  ctx.fillRect(bx, y - 7.5, w, 15);
  ctx.fillStyle = color;
  ctx.fillRect(align === 'right' ? bx + w - 2 : bx, y - 7.5, 2, 15);
  ctx.fillStyle = THEME.text;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + (align === 'right' ? 4 : 6), y + 0.5);
}

export interface GannFlags {
  fan: boolean;
  arcs: boolean;
  levels: boolean;
}

export function gannOverlay(a: Anchors, f: GannFlags): Overlay {
  return {
    z: 'below',
    draw(api: DrawApi) {
      const { ctx, plot } = api;
      const ox = api.x(api.idxAt(a.o.t));
      const oy = api.y(a.o.p);
      const right = plot.x + plot.w;
      const labels: { y: number; text: string; color: string }[] = [];

      if (f.arcs) {
        ctx.lineWidth = 1.3;
        for (const arc of ARCS) {
          ctx.strokeStyle = arc.color;
          ctx.beginPath();
          const steps = 140;
          for (let s = 0; s <= steps; s++) {
            const pt = arcPoint(a, arc.m, (Math.PI / 2) * (1 - s / steps));
            const x = api.x(api.idxAt(pt.t));
            const y = api.y(pt.p);
            if (s === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      }

      if (f.levels) {
        ctx.lineWidth = 1.2;
        for (const m of LEVEL_ARCS) {
          const color = ARCS.find((x) => x.m === m)?.color ?? '#999';
          const p = arcTop(a, m);
          const y = Math.round(api.y(p)) + 0.5;
          ctx.strokeStyle = color;
          ctx.beginPath();
          ctx.moveTo(plot.x, y);
          ctx.lineTo(right, y);
          ctx.stroke();
          labels.push({ y, text: fmtAxis(p), color });
        }
        const m0 = LEVEL_ARCS[0];
        const te = arcEnd(a, m0);
        const xe = Math.round(api.x(api.idxAt(te))) + 0.5;
        if (xe > plot.x && xe < right) {
          ctx.strokeStyle = ARCS[0].color;
          ctx.beginPath();
          ctx.moveTo(xe, plot.y);
          ctx.lineTo(xe, plot.y + plot.h);
          ctx.stroke();
          ctx.font = THEME.font;
          ctx.fillStyle = THEME.text;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          ctx.fillText(fmtShortDate(te, api.tf === '4h' ? '1d' : api.tf), xe + 4, plot.y + 4);
        }
      }

      if (f.fan) {
        const x0 = Math.max(plot.x, ox);
        for (const line of FAN) {
          ctx.strokeStyle = line.color;
          ctx.lineWidth = line.w ?? 1.2;
          ctx.beginPath();
          let started = false;
          if (ox >= plot.x) {
            ctx.moveTo(ox, oy);
            started = true;
          }
          let lastY = NaN;
          for (let x = x0; x <= right + 6; x += 5) {
            const t = api.timeAt(api.iFromX(x));
            if (t < a.o.t) continue;
            const y = api.y(fanPrice(a, line.r, t));
            if (y < plot.y - 4000 || y > plot.y + plot.h + 4000) {
              if (started) break;
              continue;
            }
            if (!started) {
              ctx.moveTo(x, y);
              started = true;
            } else ctx.lineTo(x, y);
            lastY = y;
          }
          ctx.stroke();
          const yEnd = api.y(fanPrice(a, line.r, api.timeAt(api.iFromX(right - 2))));
          if (Number.isFinite(lastY) && yEnd > plot.y + 8 && yEnd < plot.y + plot.h - 8) {
            labels.push({ y: yEnd, text: line.label, color: line.color });
          }
        }
        // origin and 1x1 point
        const hx = api.x(api.idxAt(a.h.t));
        const hy = api.y(a.h.p);
        for (const [x, y] of [[ox, oy], [hx, hy]]) {
          ctx.beginPath();
          ctx.arc(x, y, 3.5, 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          ctx.lineWidth = 1.2;
          ctx.strokeStyle = '#11806f';
          ctx.stroke();
        }
      }

      // stack labels at the right edge without overlap
      labels.sort((p, q) => p.y - q.y);
      let lastY = -1e9;
      for (const l of labels) {
        if (l.y < plot.y + 8 || l.y > plot.y + plot.h - 8) continue;
        const y = Math.max(l.y, lastY + 16);
        tag(ctx, right - 4, y, l.text, l.color);
        lastY = y;
      }
    },
  };
}

const GRID_COLORS = ['#ef9a2e', '#1fa8c4', '#4caf50', '#11806f', '#3d5bf0', '#a898dd'];

/**
 * Symmetry grid: boxes of equal time T and equal log-price height U repeated from an origin.
 * In box units (u = time / T, v = ln(price / origin) / U) every box is a unit square, so
 * arcs are circles and diagonals are 45° lines through the corners.
 */
export function gridOverlay(g: { o: Pt; c: Pt }, opts: { arcs: boolean; diagonals: boolean }): Overlay {
  return {
    z: 'below',
    draw(api: DrawApi) {
      const { ctx, plot } = api;
      const right = plot.x + plot.w;
      const bottom = plot.y + plot.h;
      const T = g.c.t - g.o.t;
      const Uraw = Math.log(g.c.p / g.o.p);
      const U = Math.abs(Uraw);
      const dir = Uraw >= 0 ? 1 : -1;
      if (!(T > 0) || !(U > 0)) return;
      const toPx = (u: number, v: number) => ({ x: api.x(api.idxAt(g.o.t + u * T)), y: api.y(g.o.p * Math.exp(v * U)) });
      const uAtX = (x: number) => (api.timeAt(api.iFromX(x)) - g.o.t) / T;
      const vAtY = (y: number) => Math.log(api.priceAt(y) / g.o.p) / U;
      const u0 = uAtX(plot.x);
      const u1 = uAtX(right);
      const vA = vAtY(bottom);
      const vB = vAtY(plot.y);
      const v0 = Math.min(vA, vB);
      const v1 = Math.max(vA, vB);
      if (![u0, u1, v0, v1].every(Number.isFinite)) return;
      const color = (n: number) => GRID_COLORS[(((n - 1) % GRID_COLORS.length) + GRID_COLORS.length) % GRID_COLORS.length];

      // diagonals through every corner: v - u = n (rising) and v + u = n (falling)
      if (opts.diagonals) {
        ctx.lineWidth = 1;
        const fam = (sign: 1 | -1, n: number) => {
          ctx.beginPath();
          let started = false;
          for (let x = plot.x; x <= right + 6; x += 6) {
            const u = uAtX(x);
            const v = n + sign * u;
            const y = api.y(g.o.p * Math.exp(v * U));
            if (!Number.isFinite(y) || y < plot.y - 3000 || y > bottom + 3000) {
              started = false;
              continue;
            }
            if (started) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
            started = true;
          }
          ctx.stroke();
        };
        const lo = Math.floor(v0 - u1) - 1;
        const hi = Math.ceil(v1 - u0) + 1;
        if (hi - lo < 120) {
          ctx.strokeStyle = 'rgba(17,128,111,0.38)';
          for (let n = lo; n <= hi; n++) fam(1, n);
        }
        const lo2 = Math.floor(v0 + u0) - 1;
        const hi2 = Math.ceil(v1 + u1) + 1;
        if (hi2 - lo2 < 120) {
          ctx.strokeStyle = 'rgba(61,91,240,0.34)';
          for (let n = lo2; n <= hi2; n++) fam(-1, n);
        }
      }

      // arcs: circles of radius k box units centred on the origin, in the box's direction
      if (opts.arcs) {
        const kMax = Math.min(14, Math.ceil(Math.hypot(Math.max(Math.abs(u0), Math.abs(u1)), Math.max(Math.abs(v0), Math.abs(v1)))) + 1);
        ctx.lineWidth = 1.3;
        for (let k = 1; k <= kMax; k++) {
          ctx.strokeStyle = color(k);
          ctx.beginPath();
          for (let s = 0; s <= 160; s++) {
            const th = (Math.PI / 2) * (s / 160);
            const p = toPx(k * Math.sin(th), dir * k * Math.cos(th));
            if (s === 0) ctx.moveTo(p.x, p.y);
            else ctx.lineTo(p.x, p.y);
          }
          ctx.stroke();
        }
      }

      // time lines
      ctx.font = THEME.font;
      ctx.lineWidth = 1.3;
      const kv0 = Math.ceil(u0);
      const kv1 = Math.floor(u1);
      if (kv1 - kv0 < 200) {
        let lastX = -1e9;
        for (let k = kv0; k <= kv1; k++) {
          const x = Math.round(api.x(api.idxAt(g.o.t + k * T))) + 0.5;
          ctx.strokeStyle = k === 0 ? 'rgba(32,34,38,0.55)' : color(k);
          ctx.beginPath();
          ctx.moveTo(x, plot.y);
          ctx.lineTo(x, bottom);
          ctx.stroke();
          if (x - lastX > 64 && x < right - 40) {
            ctx.fillStyle = THEME.text;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(fmtShortDate(g.o.t + k * T, api.tf === '4h' ? '1d' : api.tf), x + 4, plot.y + 4);
            lastX = x;
          }
        }
      }

      // price lines
      const jv0 = Math.ceil(v0);
      const jv1 = Math.floor(v1);
      if (jv1 - jv0 < 200) {
        const dense = jv1 - jv0 > 24;
        ctx.lineWidth = dense ? 0.8 : 1.3;
        ctx.globalAlpha = dense ? 0.6 : 1;
        for (let j = jv0; j <= jv1; j++) {
          const p = g.o.p * Math.exp(j * U);
          const y = Math.round(api.y(p)) + 0.5;
          const c = j === 0 ? 'rgba(32,34,38,0.55)' : color(Math.abs(j));
          ctx.strokeStyle = c;
          ctx.beginPath();
          ctx.moveTo(plot.x, y);
          ctx.lineTo(right, y);
          ctx.stroke();
          if (!dense && y > plot.y + 10 && y < bottom - 10) tag(ctx, right - 4, y, fmtAxis(p), c);
        }
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1.3;
      }

      // origin and corner markers
      for (const pt of [g.o, g.c]) {
        const x = api.x(api.idxAt(pt.t));
        const y = api.y(pt.p);
        ctx.beginPath();
        ctx.rect(x - 3.5, y - 3.5, 7, 7);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = '#1fa8c4';
        ctx.stroke();
      }
    },
  };
}

const PIV_HIGH = '#c0392b';
const PIV_LOW = '#11806f';

/** Major pivots as arrows, plus Gann day counts projected from the recent ones. */
export function gannTimeOverlay(pivots: Pivot[], proj: Projection[]): Overlay {
  return {
    z: 'below',
    draw(api: DrawApi) {
      const { ctx, plot } = api;
      const right = plot.x + plot.w;
      const bottom = plot.y + plot.h;
      const barSec = (api.timeAt(api.to) - api.timeAt(api.from)) / Math.max(1e-9, api.to - api.from);
      const groups = clusterProjections(proj, Math.max(3 * 86400, barSec * 1.01));
      ctx.font = THEME.font;
      let lastLabelX = -1e9;
      for (const g of groups) {
        const xs = g.map((p) => api.x(api.idxAt(p.t)));
        const x0 = Math.min(...xs);
        const x1 = Math.max(...xs);
        if (x1 < plot.x - 4 || x0 > right + 4) continue;
        if (g.length > 1) {
          const w = Math.max(6, x1 - x0 + 4);
          ctx.fillStyle = 'rgba(214,160,20,0.20)';
          ctx.fillRect((x0 + x1) / 2 - w / 2, plot.y, w, plot.h);
        }
        for (let k = 0; k < g.length; k++) {
          const x = Math.round(xs[k]) + 0.5;
          ctx.strokeStyle = g[k].from.high ? 'rgba(192,57,43,0.55)' : 'rgba(17,128,111,0.6)';
          ctx.lineWidth = 1;
          ctx.setLineDash([1, 3]);
          ctx.beginPath();
          ctx.moveTo(x, plot.y + 30);
          ctx.lineTo(x, bottom);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        // one label per group along the bottom edge
        const cx = (x0 + x1) / 2;
        if (cx - lastLabelX < 40 || cx < plot.x + 14 || cx > right - 14) continue;
        const text = g.length > 1 ? `×${g.length}` : g[0].label;
        const w = ctx.measureText(text).width + 8;
        ctx.fillStyle = g.length > 1 ? '#a07400' : g[0].from.high ? PIV_HIGH : PIV_LOW;
        ctx.fillRect(cx - w / 2, bottom - 17, w, 14);
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, cx, bottom - 9.5);
        lastLabelX = cx;
      }
      // pivot arrows
      for (const pv of pivots) {
        const x = api.x(api.idxAt(pv.t));
        if (x < plot.x - 8 || x > right + 8) continue;
        const y = api.y(pv.p) + (pv.high ? -6 : 6);
        const d = pv.high ? -1 : 1;
        ctx.fillStyle = pv.high ? PIV_HIGH : PIV_LOW;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 6, y + d * 9);
        ctx.lineTo(x + 2.4, y + d * 9);
        ctx.lineTo(x + 2.4, y + d * 16);
        ctx.lineTo(x - 2.4, y + d * 16);
        ctx.lineTo(x - 2.4, y + d * 9);
        ctx.lineTo(x - 6, y + d * 9);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = THEME.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = pv.high ? 'bottom' : 'top';
        ctx.fillText(fmtAxis(pv.p), x, y + d * 19);
      }
    },
  };
}

export function moonOverlay(): Overlay {
  return {
    z: 'below',
    draw(api: DrawApi) {
      const { ctx, plot } = api;
      const t0 = api.timeAt(api.from);
      const t1 = api.timeAt(api.to);
      const moons = moonPhases(t0, t1);
      const barSec = (api.timeAt(api.to) - api.timeAt(api.from)) / Math.max(1e-9, api.to - api.from);
      const gapPx = (api.spacing * 14.77 * 86400) / barSec;
      // Three densities: full lines with lettered badges, lettered badges on two rows, or bare ticks.
      const mode = gapPx >= 16 ? 'lines' : gapPx >= 6 ? 'badges' : 'ticks';
      const badge = (x: number, y: number, full: boolean, r: number) => {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = full ? '#fbfaf6' : '#2a2c31';
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#6b6a68';
        ctx.stroke();
        ctx.fillStyle = full ? '#202226' : '#fbfaf6';
        ctx.font = `700 ${r >= 6 ? 9 : 8}px 'IBM Plex Sans', system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(full ? 'F' : 'N', x, y + 0.5);
      };
      for (const m of moons) {
        const x = Math.round(api.x(api.idxAt(m.t))) + 0.5;
        if (x < plot.x || x > plot.x + plot.w) continue;
        if (mode === 'ticks') {
          // zoomed far out: a short tick per phase along the top edge
          ctx.fillStyle = m.full ? 'rgba(250,249,244,0.95)' : 'rgba(40,42,48,0.7)';
          ctx.fillRect(x - 0.5, plot.y, 1.5, m.full ? 7 : 4);
          continue;
        }
        if (mode === 'badges') {
          badge(x, plot.y + (m.full ? 8 : 20), m.full, 5);
          continue;
        }
        ctx.strokeStyle = m.full ? 'rgba(120,118,112,0.55)' : 'rgba(40,42,48,0.4)';
        ctx.setLineDash(m.full ? [2, 3] : [5, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, plot.y + 24);
        ctx.lineTo(x, plot.y + plot.h);
        ctx.stroke();
        ctx.setLineDash([]);
        badge(x, plot.y + 14, m.full, 7);
      }
    },
  };
}

const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_EXT = [1.272, 1.618];

/** Fibonacci retracement on the swing in view: from the visible low to the visible high (in time order). */
export function fibOverlay(): Overlay {
  return {
    z: 'above',
    draw(api: DrawApi) {
      const { ctx, plot, bars } = api;
      const a = Math.max(0, Math.ceil(api.from));
      const z = Math.min(bars.length - 1, Math.floor(api.to));
      if (z - a < 5) return;
      let hi = a;
      let lo = a;
      for (let i = a; i <= z; i++) {
        if (bars[i].h > bars[hi].h) hi = i;
        if (bars[i].l < bars[lo].l) lo = i;
      }
      const H = bars[hi].h;
      const Lw = bars[lo].l;
      const up = lo < hi;
      const xs = api.x(Math.min(lo, hi));
      const right = plot.x + plot.w;
      const lv: { r: number; p: number; ext: boolean }[] = FIB.map((r) => ({ r, p: up ? H - r * (H - Lw) : Lw + r * (H - Lw), ext: false }));
      for (const e of FIB_EXT) lv.push({ r: e, p: up ? H + (e - 1) * (H - Lw) : Lw - (e - 1) * (H - Lw), ext: true });
      // golden pocket
      const g1 = api.y(up ? H - 0.618 * (H - Lw) : Lw + 0.618 * (H - Lw));
      const g2 = api.y(up ? H - 0.65 * (H - Lw) : Lw + 0.65 * (H - Lw));
      ctx.fillStyle = 'rgba(214,160,20,0.16)';
      ctx.fillRect(xs, Math.min(g1, g2), right - xs, Math.abs(g2 - g1));
      ctx.font = THEME.font;
      for (const l of lv) {
        if (l.p <= 0) continue;
        const y = Math.round(api.y(l.p)) + 0.5;
        if (y < plot.y || y > plot.y + plot.h) continue;
        const key = l.r === 0.618 || l.r === 0.5;
        ctx.strokeStyle = l.ext ? 'rgba(123,92,0,0.6)' : key ? '#a07400' : 'rgba(123,92,0,0.75)';
        ctx.lineWidth = key ? 1.4 : 1;
        ctx.setLineDash(l.ext ? [6, 4] : l.r === 0 || l.r === 1 ? [] : [2, 3]);
        ctx.beginPath();
        ctx.moveTo(xs, y);
        ctx.lineTo(right, y);
        ctx.stroke();
        ctx.setLineDash([]);
        const text = `${l.r.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}  ${fmtAxis(l.p)}`;
        ctx.fillStyle = '#5c4500';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(text, xs + 4, y - 2);
      }
    },
  };
}

/** Shaded area between two lines (Bollinger Bands). */
export function bandFill(upper: number[], lower: number[], color: string): Overlay {
  return {
    z: 'below',
    draw(api: DrawApi) {
      const { ctx } = api;
      const a = Math.max(0, Math.floor(api.from) - 1);
      const z = Math.min(upper.length - 1, Math.ceil(api.to) + 1);
      ctx.fillStyle = color;
      // On a log scale a band below zero can't be drawn, so fill each drawable stretch separately.
      const bottom = api.plot.y + api.plot.h;
      let seg: [number, number, number][] = [];
      const flush = () => {
        if (seg.length >= 2) {
          ctx.beginPath();
          seg.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          for (let k = seg.length - 1; k >= 0; k--) ctx.lineTo(seg[k][0], seg[k][2]);
          ctx.closePath();
          ctx.fill();
        }
        seg = [];
      };
      for (let i = a; i <= z; i++) {
        if (!Number.isFinite(upper[i]) || !Number.isFinite(lower[i]) || (api.log && upper[i] <= 0)) {
          flush();
          continue;
        }
        const yl = api.log && lower[i] <= 0 ? bottom : api.y(lower[i]);
        seg.push([api.x(i), api.y(upper[i]), yl]);
      }
      flush();
    },
  };
}
