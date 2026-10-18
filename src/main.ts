import { Chart, LineSpec, Overlay, SubPane } from './chart.js';
import { Bar, Pt, TF, TFS, TF_ORDER } from './types.js';
import { DataError, FngPoint, LiveState, getFearGreed, getKlines, getSymbols, mergeBar, subscribe } from './data.js';
import { bollinger, closes, ema, macd, rsi, sma } from './indicators.js';
import { Anchors, ARCS, FAN, LEVEL_ARCS, PRESETS, Preset, arcTop, autoAnchors, fanPrice, validAnchors } from './gann.js';
import { bandFill, fibOverlay, gannOverlay, moonOverlay } from './overlays.js';
import { moonPhases } from './moon.js';
import { esc, fmtDate, fmtPct, fmtPrice } from './format.js';

// ---------- layers ----------

type LayerKey =
  | 'fan' | 'arcs' | 'glevels'
  | 'sma20' | 'ema21' | 'sma50' | 'sma100' | 'sma200'
  | 'bb' | 'fib' | 'moon'
  | 'vol' | 'rsi' | 'macd' | 'fng';

interface LayerDef {
  k: LayerKey;
  label: string;
  color: string;
  group: 'gann' | 'ma' | 'tools' | 'panes';
  title?: string;
}

const LAYERS: LayerDef[] = [
  { k: 'fan', label: 'Fan', color: '#11806f', group: 'gann' },
  { k: 'arcs', label: 'Arcs', color: '#ef9a2e', group: 'gann' },
  { k: 'glevels', label: 'Levels', color: '#1fa8c4', group: 'gann', title: 'Horizontal and vertical lines from the arcs' },
  { k: 'sma20', label: 'SMA 20', color: '#b07c00', group: 'ma' },
  { k: 'ema21', label: 'EMA 21', color: '#2f6fde', group: 'ma' },
  { k: 'sma50', label: 'SMA 50', color: '#8e44ad', group: 'ma' },
  { k: 'sma100', label: 'SMA 100', color: '#d35400', group: 'ma' },
  { k: 'sma200', label: 'SMA 200', color: '#b71c1c', group: 'ma' },
  { k: 'bb', label: 'Bollinger', color: '#3b82c4', group: 'tools', title: 'Bollinger Bands, 20 periods, 2 standard deviations' },
  { k: 'fib', label: 'Fibonacci', color: '#a07400', group: 'tools', title: 'Retracement on the swing in view. Zoom or scroll to change the swing.' },
  { k: 'moon', label: 'Moons', color: '#8c8b88', group: 'tools', title: 'Full and new moons' },
  { k: 'vol', label: 'Volume', color: '#8c8b88', group: 'panes' },
  { k: 'rsi', label: 'RSI', color: '#7e57c2', group: 'panes' },
  { k: 'macd', label: 'MACD', color: '#2962ff', group: 'panes' },
  { k: 'fng', label: 'Fear & Greed', color: '#d9822b', group: 'panes' },
];

const MAS: { k: LayerKey; p: number; type: 'sma' | 'ema' }[] = [
  { k: 'sma20', p: 20, type: 'sma' },
  { k: 'ema21', p: 21, type: 'ema' },
  { k: 'sma50', p: 50, type: 'sma' },
  { k: 'sma100', p: 100, type: 'sma' },
  { k: 'sma200', p: 200, type: 'sma' },
];

// ---------- state ----------

interface State {
  sym: string;
  tf: TF;
  log: boolean;
  preset: Preset;
  layers: Record<LayerKey, boolean>;
  custom: Record<string, { o: Pt; h: Pt }>;
  recent: string[];
}

const DEFAULT: State = {
  sym: 'NEARUSDT',
  tf: '1w',
  log: true,
  preset: 'last',
  layers: {
    fan: true, arcs: true, glevels: true,
    sma20: false, ema21: false, sma50: false, sma100: false, sma200: false,
    bb: false, fib: false, moon: false,
    vol: true, rsi: false, macd: false, fng: false,
  },
  custom: {},
  recent: ['NEARUSDT', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
};

function loadState(): State {
  try {
    const s = JSON.parse(localStorage.getItem('gd:state') || 'null') as Partial<State> | null;
    if (s && typeof s === 'object') {
      const st: State = { ...DEFAULT, ...s, layers: { ...DEFAULT.layers, ...(s.layers || {}) }, custom: s.custom || {} };
      if (!TF_ORDER.includes(st.tf)) st.tf = DEFAULT.tf;
      if (!PRESETS.some((p) => p.k === st.preset)) st.preset = DEFAULT.preset;
      if (!/^[A-Z0-9]{1,20}USDT$/.test(st.sym)) st.sym = DEFAULT.sym;
      if (!Array.isArray(st.recent)) st.recent = DEFAULT.recent;
      return st;
    }
  } catch {
    /* fall through */
  }
  return JSON.parse(JSON.stringify(DEFAULT)) as State;
}

const S = loadState();
function save(): void {
  try {
    localStorage.setItem('gd:state', JSON.stringify(S));
  } catch {
    /* blocked storage: settings just won't persist */
  }
}

const base = (sym: string) => sym.replace(/USDT$/, '');

// ---------- DOM ----------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const chartHost = $('chart');
const chart = new Chart(chartHost);

let bars: Bar[] = [];
let daily: Bar[] = [];
let dailySym = '';
let anchors: Anchors | null = null;
let fng: FngPoint[] | null = null;
let fngFailed = false;
let liveState: LiveState = 'off';
let stopLive: (() => void) | null = null;
let loadToken = 0;
let hoverIdx: number | null = null;

// ---------- layer toolbar ----------

function chip(d: LayerDef): string {
  return `<button type="button" class="chip" data-k="${d.k}" aria-pressed="${S.layers[d.k]}" style="--sw:${d.color}"${d.title ? ` title="${esc(d.title)}"` : ''}><i></i>${esc(d.label)}</button>`;
}

function buildToolbar(): void {
  const g = (grp: LayerDef['group']) => LAYERS.filter((l) => l.group === grp).map(chip).join('');
  $('layers').innerHTML = `
    <div class="grp">
      <label class="sel"><span>Gann</span>
        <select id="preset" aria-label="Gann fan preset">
          ${PRESETS.map((p) => `<option value="${p.k}" title="${esc(p.desc)}">${esc(p.label)}</option>`).join('')}
        </select>
      </label>
      ${g('gann')}
      <button type="button" class="chip ghost" id="pick">Pick anchors</button>
    </div>
    <div class="grp"><span class="glabel">Averages</span>${g('ma')}</div>
    <div class="grp"><span class="glabel">Tools</span>${g('tools')}</div>
    <div class="grp"><span class="glabel">Panes</span>${g('panes')}</div>`;
  const sel = $('preset') as unknown as HTMLSelectElement;
  sel.value = S.preset;
  sel.addEventListener('change', () => {
    S.preset = sel.value as Preset;
    save();
    endPick();
    recomputeAnchors();
    if (S.preset === 'custom' && !anchors) startPick();
    refresh();
  });
  $('layers').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button.chip[data-k]');
    if (!b) return;
    const k = b.dataset.k as LayerKey;
    S.layers[k] = !S.layers[k];
    b.setAttribute('aria-pressed', String(S.layers[k]));
    save();
    if (k === 'fng') ensureFng();
    refresh();
  });
  $('pick').addEventListener('click', startPick);
}

// ---------- header controls ----------

function bindSeg(id: string, attr: string, current: () => string, set: (v: string) => void): void {
  const host = $(id);
  const sync = () => host.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[attr] === current())));
  host.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b) return;
    set(b.dataset[attr] as string);
    sync();
  });
  sync();
}

bindSeg('tf', 'tf', () => S.tf, (v) => {
  if (v === S.tf) return;
  S.tf = v as TF;
  save();
  load();
});

bindSeg('scale', 'log', () => (S.log ? '1' : '0'), (v) => {
  S.log = v === '1';
  save();
  chart.setLog(S.log);
});

// ---------- search ----------

const q = $<HTMLInputElement>('q');
const results = $('results');
let symbols: string[] = [];
let symLoad: Promise<void> | null = null;
let items: string[] = [];
let active = 0;

function ensureSymbols(): void {
  if (!symLoad) {
    symLoad = getSymbols()
      .then((s) => {
        symbols = s;
        if (document.activeElement === q) renderResults();
      })
      .catch(() => {
        symLoad = null;
      });
  }
}

function renderResults(): void {
  const v = q.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/USDT$/, '');
  if (!v || v === base(S.sym)) {
    items = S.recent.map(base);
  } else {
    const pre = symbols.filter((s) => s.startsWith(v));
    const inc = symbols.filter((s) => !s.startsWith(v) && s.includes(v));
    items = [...pre, ...inc].slice(0, 8);
    if (!items.includes(v)) items = items.length ? items : [v];
  }
  active = 0;
  const head = !v || v === base(S.sym) ? '<li class="rh" aria-hidden="true">Recent</li>' : '';
  results.innerHTML =
    head +
    items
      .map((s, i) => `<li role="option" id="opt-${i}" data-s="${esc(s)}" aria-selected="${i === active}"><b>${esc(s)}</b><span>/USDT</span></li>`)
      .join('');
  results.hidden = false;
  q.setAttribute('aria-expanded', 'true');
}

function choose(b: string): void {
  const clean = b.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/USDT$/, '');
  if (!clean) return;
  const sym = clean + 'USDT';
  results.hidden = true;
  q.blur();
  q.value = clean;
  if (sym === S.sym && bars.length) return;
  load(sym);
}

q.addEventListener('focus', () => {
  q.select();
  ensureSymbols();
  renderResults();
});
q.addEventListener('input', renderResults);
q.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(1, items.length);
    results.querySelectorAll('li[role=option]').forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const typed = q.value.trim().toUpperCase().replace(/USDT$/, '');
    choose(items[active] && (items[active].startsWith(typed) || !typed) ? items[active] : typed);
  } else if (e.key === 'Escape') {
    q.blur();
  }
});
q.addEventListener('blur', () => {
  setTimeout(() => {
    results.hidden = true;
    q.setAttribute('aria-expanded', 'false');
    q.value = base(S.sym);
  }, 120);
});
results.addEventListener('mousedown', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-s]');
  if (!li) return;
  e.preventDefault();
  choose(li.dataset.s as string);
});

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== q) {
    e.preventDefault();
    q.focus();
  }
  if (e.key === 'Escape' && chart.pickMode) endPick();
});

// ---------- status, toast ----------

function setStatus(msg: string | null, error = false): void {
  const el = $('status');
  el.hidden = !msg;
  el.classList.toggle('error', error);
  el.textContent = msg ?? '';
}

function toast(html: string | null): void {
  const el = $('toast');
  el.hidden = !html;
  el.innerHTML = html ?? '';
}

// ---------- anchors + custom picking ----------

let pickStep = 0;
let pickO: Pt | null = null;

function startPick(): void {
  if (!bars.length) return;
  chart.pickMode = true;
  pickStep = 0;
  pickO = null;
  chartHost.classList.add('picking');
  toast('<span>Tap the <b>low</b> the fan should start from.</span><button type="button" id="pickCancel">Cancel</button>');
  $('pickCancel').addEventListener('click', endPick);
}

function endPick(): void {
  chart.pickMode = false;
  chartHost.classList.remove('picking');
  toast(null);
}

chart.onTap = (i) => {
  const b = bars[i];
  if (!b) return;
  if (pickStep === 0) {
    pickO = { t: b.t, p: b.l };
    pickStep = 1;
    toast(`<span>Low set at <b>${fmtPrice(b.l)}</b>. Now tap the <b>high</b> the 1x1 line runs through.</span><button type="button" id="pickCancel">Cancel</button>`);
    $('pickCancel').addEventListener('click', endPick);
    return;
  }
  const cand = { o: pickO as Pt, h: { t: b.t, p: b.h } };
  if (!validAnchors(cand)) {
    toast('<span>The high has to come after the low and sit above it. Tap a later, higher candle.</span><button type="button" id="pickCancel">Cancel</button>');
    $('pickCancel').addEventListener('click', endPick);
    return;
  }
  S.custom[S.sym] = cand;
  S.preset = 'custom';
  ($('preset') as unknown as HTMLSelectElement).value = 'custom';
  save();
  endPick();
  recomputeAnchors();
  refresh();
};

function recomputeAnchors(): void {
  if (S.preset === 'custom') {
    const c = S.custom[S.sym];
    anchors = validAnchors(c) ? { o: c.o, h: c.h, preset: 'custom' } : null;
    return;
  }
  anchors = daily.length ? autoAnchors(daily, S.preset) : null;
}

// ---------- fear & greed ----------

function ensureFng(): void {
  if (fng || fngFailed) return;
  getFearGreed()
    .then((p) => {
      fng = p;
      refresh();
    })
    .catch(() => {
      fngFailed = true;
      renderSide();
    });
}

function fngSeries(): number[] {
  const out = new Array<number>(bars.length).fill(NaN);
  if (!fng || !fng.length) return out;
  const now = Date.now() / 1000;
  const dur = TFS[S.tf].sec;
  let j = 0;
  for (let i = 0; i < bars.length; i++) {
    const end = Math.min((bars[i + 1]?.t ?? bars[i].t + dur) - 1, now);
    while (j + 1 < fng.length && fng[j + 1].t <= end) j++;
    if (fng[j].t <= end) out[i] = fng[j].v;
  }
  return out;
}

// ---------- render ----------

function paneHeight(n: number): number {
  const h = chartHost.clientHeight || 500;
  const each = Math.round(h * (n > 2 ? 0.15 : 0.18));
  return Math.max(58, Math.min(118, each));
}

function digitsFor(p: number): number {
  return p < 0.01 ? 7 : p < 1 ? 5 : p < 100 ? 3 : 1;
}

function refresh(): void {
  if (!bars.length) return;
  const c = closes(bars);
  const lines: LineSpec[] = [];
  const overlays: Overlay[] = [];
  const panes: SubPane[] = [];

  if (S.layers.bb) {
    const bb = bollinger(c, 20, 2);
    overlays.push(bandFill(bb.up, bb.lo, 'rgba(59,130,196,0.10)'));
    lines.push(
      { values: bb.up, color: '#3b82c4', width: 1 },
      { values: bb.lo, color: '#3b82c4', width: 1 },
      { values: bb.mid, color: '#3b82c4', width: 1, dash: [4, 3] },
    );
  }
  for (const m of MAS) {
    if (!S.layers[m.k]) continue;
    const color = LAYERS.find((l) => l.k === m.k)?.color ?? '#333';
    lines.push({ values: m.type === 'sma' ? sma(c, m.p) : ema(c, m.p), color, width: 1.5 });
  }
  if (anchors && (S.layers.fan || S.layers.arcs || S.layers.glevels)) {
    overlays.push(gannOverlay(anchors, { fan: S.layers.fan, arcs: S.layers.arcs, levels: S.layers.glevels }));
  }
  if (S.layers.moon) overlays.push(moonOverlay());
  if (S.layers.fib) overlays.push(fibOverlay());

  const nPanes = (['rsi', 'macd', 'fng'] as LayerKey[]).filter((k) => S.layers[k]).length;
  const ph = paneHeight(nPanes);
  if (S.layers.rsi) {
    panes.push({
      id: 'rsi', title: 'RSI 14', height: ph, range: [0, 100], ticks: [30, 50, 70], digits: 1,
      lines: [{ values: rsi(c, 14), color: '#7e57c2', width: 1.4 }],
      hlines: [{ v: 70, color: 'rgba(126,87,194,0.7)' }, { v: 30, color: 'rgba(126,87,194,0.7)' }],
      bands: [{ from: 30, to: 70, color: 'rgba(126,87,194,0.07)' }],
    });
  }
  if (S.layers.macd) {
    const m = macd(c);
    const colors = m.hist.map((v, i) => {
      const prev = m.hist[i - 1] ?? 0;
      return v >= 0 ? (v >= prev ? '#26a69a' : '#9fd6cf') : v <= prev ? '#ef5350' : '#f4b3b5';
    });
    panes.push({
      id: 'macd', title: 'MACD 12 26 9', height: ph, digits: digitsFor(c[c.length - 1]),
      lines: [{ values: m.macd, color: '#2962ff', width: 1.3 }, { values: m.signal, color: '#ff6d00', width: 1.3 }],
      hist: { values: m.hist, colors },
      hlines: [{ v: 0, color: 'rgba(0,0,0,0.25)', dash: [] }],
    });
  }
  if (S.layers.fng) {
    panes.push({
      id: 'fng', title: fng ? 'Crypto Fear & Greed' : fngFailed ? 'Fear & Greed unavailable' : 'Fear & Greed loading', height: ph,
      range: [0, 100], ticks: [25, 50, 75], digits: 0,
      lines: [{ values: fngSeries(), color: '#d9822b', width: 1.5 }],
      bands: [{ from: 0, to: 25, color: 'rgba(242,54,69,0.10)' }, { from: 75, to: 100, color: 'rgba(8,153,129,0.12)' }],
      hlines: [{ v: 50, color: 'rgba(0,0,0,0.22)' }],
    });
  }
  chart.setLayers(lines, overlays, panes, S.layers.vol);
  renderQuote();
  renderOhlc();
  renderSide();
}

let refreshTimer = 0;
function scheduleRefresh(): void {
  if (refreshTimer) return;
  refreshTimer = window.setTimeout(() => {
    refreshTimer = 0;
    refresh();
  }, 900);
}

function renderQuote(): void {
  const last = bars[bars.length - 1];
  if (!last) return;
  const prev = bars[bars.length - 2]?.c ?? last.o;
  const ch = ((last.c - prev) / prev) * 100;
  $('price').textContent = fmtPrice(last.c);
  const chg = $('chg');
  chg.textContent = `${fmtPct(ch, 2)} ${TFS[S.tf].word}`;
  chg.className = 'chg ' + (ch >= 0 ? 'up' : 'down');
  document.title = `${base(S.sym)} ${fmtPrice(last.c)} · Wil’s Trading Desk`;
}

function renderOhlc(): void {
  const i = hoverIdx ?? bars.length - 1;
  const b = bars[i];
  if (!b) return;
  const prev = bars[i - 1]?.c ?? b.o;
  const ch = ((b.c - prev) / prev) * 100;
  const cls = b.c >= prev ? 'up' : 'down';
  $('ohlc').innerHTML =
    `<span class="pair"><b>${esc(base(S.sym))}</b>/USDT · ${TFS[S.tf].label} · Binance</span>` +
    `<span>${fmtDate(b.t, S.tf)}</span>` +
    `<span>O <b class="${cls}">${fmtPrice(b.o)}</b></span><span>H <b class="${cls}">${fmtPrice(b.h)}</b></span>` +
    `<span>L <b class="${cls}">${fmtPrice(b.l)}</b></span><span>C <b class="${cls}">${fmtPrice(b.c)}</b></span>` +
    `<span><b class="${cls}">${fmtPct(ch, 2)}</b></span>`;
}

chart.onHover = (i) => {
  hoverIdx = i;
  renderOhlc();
};

function renderLive(): void {
  const el = $('live');
  const text = { live: 'Live', polling: 'Every 20s', off: 'Offline' }[liveState];
  el.className = 'live ' + liveState;
  el.textContent = text;
  el.title = {
    live: 'Streaming the forming candle from Binance',
    polling: "Couldn't open a live stream, so prices refresh every 20 seconds",
    off: 'Not receiving updates. Check your connection.',
  }[liveState];
}

function renderSide(): void {
  renderGannCard();
  renderFngCard();
  renderMoonCard();
}

function renderGannCard(): void {
  const el = $('gannCard');
  const preset = PRESETS.find((p) => p.k === S.preset);
  const head = `<div class="card-h"><h2>Gann fan</h2><span class="pill">${esc(preset?.label ?? '')}</span></div>`;
  if (!anchors) {
    const msg = S.preset === 'custom'
      ? 'No custom anchors for this coin yet. Choose <b>Pick anchors</b>, then tap the low and the high.'
      : daily.length
        ? 'Not enough history to place a fan for this coin.'
        : 'Loading history…';
    el.innerHTML = head + `<p class="note">${msg}</p>`;
    return;
  }
  const last = bars[bars.length - 1];
  const price = last?.c ?? anchors.h.p;
  const now = Date.now() / 1000;
  type Row = { name: string; p: number; color: string; now?: boolean };
  const rows: Row[] = [];
  for (const f of FAN) rows.push({ name: `${f.label} fan`, p: fanPrice(anchors, f.r, now), color: f.color });
  for (const m of LEVEL_ARCS) {
    rows.push({ name: `Arc ${m} top`, p: arcTop(anchors, m), color: ARCS.find((a) => a.m === m)?.color ?? '#999' });
  }
  const near = rows.filter((r) => r.p > price / 5 && r.p < price * 5);
  near.push({ name: 'Last price', p: price, color: '#ececee', now: true });
  near.sort((a, b) => b.p - a.p);
  el.innerHTML =
    head +
    `<dl class="anch">
      <div><dt>Origin low</dt><dd>${fmtDate(anchors.o.t)} · ${fmtPrice(anchors.o.p)}</dd></div>
      <div><dt>1x1 through</dt><dd>${fmtDate(anchors.h.t)} · ${fmtPrice(anchors.h.p)}</dd></div>
    </dl>` +
    (anchors.note ? `<p class="note">${esc(anchors.note)}</p>` : '') +
    `<h3>Lines today</h3><ul class="lv">${near
      .map((r) => {
        const d = ((r.p - price) / price) * 100;
        return `<li${r.now ? ' class="now"' : ''}><span class="sw" style="background:${r.color}"></span><span class="nm">${esc(r.name)}</span><span class="p">${fmtPrice(r.p)}</span><span class="d">${r.now ? '' : fmtPct(d)}</span></li>`;
      })
      .join('')}</ul>`;
}

function renderFngCard(): void {
  const el = $('fngCard');
  const head = '<div class="card-h"><h2>Crypto Fear &amp; Greed</h2></div>';
  if (!fng) {
    el.innerHTML = head + `<p class="note">${fngFailed ? "Couldn't load the index right now." : 'Loading…'}</p>`;
    return;
  }
  const latest = fng[fng.length - 1];
  const ago = (days: number) => {
    const t = latest.t - days * 86400;
    let v = NaN;
    for (let i = fng!.length - 1; i >= 0; i--) if (fng![i].t <= t + 3600) {
      v = fng![i].v;
      break;
    }
    return Number.isFinite(v) ? String(v) : '–';
  };
  const zone = latest.v < 25 ? 'xf' : latest.v < 45 ? 'f' : latest.v <= 55 ? 'n' : latest.v <= 75 ? 'g' : 'xg';
  el.innerHTML =
    head +
    `<div class="fng"><span class="fv ${zone}">${latest.v}</span><span class="fl">${esc(latest.label)}</span></div>
     <div class="gauge" role="img" aria-label="Index ${latest.v} of 100"><span style="left:${latest.v}%"></span></div>
     <div class="gscale"><span>Extreme fear</span><span>Extreme greed</span></div>
     <p class="kv"><span>Yesterday <b>${ago(1)}</b></span><span>7 days <b>${ago(7)}</b></span><span>30 days <b>${ago(30)}</b></span></p>
     <p class="credit">Data: <a href="https://alternative.me/crypto/fear-and-greed-index/" target="_blank" rel="noopener">Alternative.me</a></p>`;
}

function renderMoonCard(): void {
  const el = $('moonCard');
  const now = Date.now() / 1000;
  const next = moonPhases(now, now + 40 * 86400).slice(0, 2);
  const prev = moonPhases(now - 20 * 86400, now).slice(-1)[0];
  const row = (m: { t: number; full: boolean }) => {
    const days = Math.round((m.t - now) / 86400);
    const rel = days === 0 ? 'today' : days > 0 ? `in ${days}d` : `${-days}d ago`;
    return `<li><span class="mi ${m.full ? 'full' : 'new'}" aria-hidden="true"></span><span class="nm">${m.full ? 'Full' : 'New'} moon</span><span class="p">${fmtDate(m.t)}</span><span class="d">${rel}</span></li>`;
  };
  el.innerHTML =
    '<div class="card-h"><h2>Moon cycle</h2></div><ul class="lv moon">' +
    (prev ? row(prev) : '') +
    next.map(row).join('') +
    '</ul>';
}

// ---------- loading ----------

let toastTimer = 0;
function flash(msg: string): void {
  toast(`<span>${esc(msg)}</span>`);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    if (!chart.pickMode) toast(null);
  }, 4500);
}

/** Load a coin. The current coin only changes once the new one has loaded. */
async function load(sym = S.sym): Promise<void> {
  const my = ++loadToken;
  const tf = S.tf;
  endPick();
  setStatus(`Loading ${base(sym)}…`);
  try {
    const barsP = getKlines(sym, tf);
    const dailyP = tf === '1d' ? barsP : dailySym === sym ? Promise.resolve(daily) : getKlines(sym, '1d');
    const [b, d] = await Promise.all([barsP, dailyP]);
    if (my !== loadToken) return;
    if (!b.length) throw new DataError(`No ${base(sym)} candles on Binance.`, 404);
    stopLive?.();
    stopLive = null;
    hoverIdx = null;
    bars = b;
    daily = tf === '1d' ? b : d;
    dailySym = sym;
    S.sym = sym;
    S.recent = [sym, ...S.recent.filter((s) => s !== sym)].slice(0, 6);
    save();
    q.value = base(sym);
    recomputeAnchors();
    chart.setLog(S.log);
    chart.setBars(bars, tf);
    setStatus(null);
    refresh();
    liveState = 'off';
    renderLive();
    stopLive = subscribe(sym, tf, onLive, (s) => {
      liveState = s;
      renderLive();
    });
  } catch (e) {
    if (my !== loadToken) return;
    const status = e instanceof DataError ? e.status : 0;
    const msg = status === 400 || status === 404
      ? `${base(sym)} doesn't trade against USDT on Binance. Try another coin.`
      : `Couldn't load ${base(sym)}. ${e instanceof Error ? e.message : ''}`;
    if (bars.length && sym !== S.sym) {
      // keep the chart that was already showing
      setStatus(null);
      q.value = base(S.sym);
      flash(msg);
    } else {
      setStatus(msg, true);
    }
  }
}

function onLive(b: Bar): void {
  if (!bars.length) return;
  const added = mergeBar(bars, b);
  if (added) chart.setBars(bars, S.tf, true);
  else chart.redraw();
  renderQuote();
  if (hoverIdx === null) renderOhlc();
  scheduleRefresh();
}

// Keep the daily history (used for anchors) fresh while the app stays open.
setInterval(async () => {
  if (!daily.length || S.tf === '1d') return;
  try {
    const sym = S.sym;
    const tail = await getKlines(sym, '1d', 3);
    if (sym !== dailySym) return;
    tail.forEach((b) => mergeBar(daily, b));
    if (S.preset === 'latest') {
      recomputeAnchors();
      scheduleRefresh();
    }
  } catch {
    /* try again next interval */
  }
}, 10 * 60 * 1000);

// Re-fit pane heights when the window changes size.
let resizeTimer = 0;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (S.layers.rsi || S.layers.macd || S.layers.fng) refresh();
  }, 150);
}).observe(chartHost);

// Moon card and "lines today" drift with the clock.
setInterval(renderSide, 60 * 60 * 1000);

buildToolbar();
renderLive();
renderMoonCard();
ensureFng();
load();
