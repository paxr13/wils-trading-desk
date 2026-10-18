import { Bar, TF, TFS } from './types.js';

const BIN = 'https://data-api.binance.vision/api/v3';
const WS = 'wss://data-stream.binance.vision/ws';
const FNG = 'https://api.alternative.me/fng/?limit=0&format=json';

export class DataError extends Error {
  constructor(message: string, public status = 0) {
    super(message);
  }
}

let viaProxy = false;

/** Fetch JSON directly; if the browser is blocked (CORS or region), retry through our Netlify proxy. */
export async function getJSON<T>(url: string): Promise<T> {
  let directStatus = 0;
  if (!viaProxy) {
    try {
      const r = await fetch(url);
      if (r.ok) return (await r.json()) as T;
      directStatus = r.status;
      if (r.status === 400) throw new DataError('Bad request', 400);
    } catch (e) {
      if (e instanceof DataError) throw e;
    }
  }
  let r: Response;
  try {
    r = await fetch('/api/proxy?url=' + encodeURIComponent(url));
  } catch {
    throw new DataError('Network error. Check your connection.', directStatus);
  }
  if (!r.ok) throw new DataError(`Market data request failed (${r.status || directStatus})`, r.status || directStatus);
  viaProxy = true;
  return (await r.json()) as T;
}

type Kline = [number, string, string, string, string, string, ...unknown[]];

function toBar(k: Kline): Bar {
  return { t: Math.round(k[0] / 1000), o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] };
}

/** Load up to `max` bars, newest last, paging backwards 1000 at a time. */
export async function getKlines(symbol: string, tf: TF, max = TFS[tf].max): Promise<Bar[]> {
  let out: Bar[] = [];
  let end: number | undefined;
  while (out.length < max) {
    const limit = Math.min(1000, max - out.length);
    const url = `${BIN}/klines?symbol=${encodeURIComponent(symbol)}&interval=${TFS[tf].binance}&limit=${limit}` +
      (end !== undefined ? `&endTime=${end}` : '');
    const rows = await getJSON<Kline[]>(url);
    if (!rows.length) break;
    out = rows.map(toBar).concat(out);
    if (rows.length < limit) break;
    end = rows[0][0] - 1;
  }
  return out;
}

/** Insert or replace a bar by open time. Returns true if a new bar was appended. */
export function mergeBar(bars: Bar[], b: Bar): boolean {
  const last = bars[bars.length - 1];
  if (!last || b.t > last.t) {
    bars.push(b);
    return true;
  }
  for (let i = bars.length - 1; i >= Math.max(0, bars.length - 5); i--) {
    if (bars[i].t === b.t) {
      bars[i] = b;
      return false;
    }
  }
  return false;
}

export type LiveState = 'live' | 'polling' | 'off';

/** Stream the forming candle. Falls back to polling every 20 s if the socket can't connect. */
export function subscribe(
  symbol: string,
  tf: TF,
  onBar: (b: Bar) => void,
  onState: (s: LiveState) => void,
): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let fails = 0;
  let poll = 0;
  let retry = 0;

  const startPolling = () => {
    onState('polling');
    const tick = async () => {
      try {
        const bars = await getKlines(symbol, tf, 2);
        bars.forEach(onBar);
        onState('polling');
      } catch {
        onState('off');
      }
    };
    tick();
    poll = window.setInterval(tick, 20000);
  };

  const connect = () => {
    if (stopped) return;
    try {
      ws = new WebSocket(`${WS}/${symbol.toLowerCase()}@kline_${TFS[tf].binance}`);
    } catch {
      startPolling();
      return;
    }
    ws.onopen = () => {
      fails = 0;
      onState('live');
    };
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data as string);
        const k = m.k;
        if (!k) return;
        onBar({ t: Math.round(k.t / 1000), o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v });
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (stopped) return;
      fails++;
      if (fails >= 3) {
        startPolling();
        return;
      }
      onState('off');
      retry = window.setTimeout(connect, 1500 * fails);
    };
  };

  connect();
  return () => {
    stopped = true;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    clearInterval(poll);
    clearTimeout(retry);
  };
}

const STABLES = new Set([
  'USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'PAX', 'UST', 'USDS', 'EUR', 'GBP', 'AUD', 'TRY', 'BRL',
  'EURI', 'AEUR', 'USD1', 'XUSD', 'PYUSD', 'RLUSD', 'USDE', 'BFUSD', 'U',
]);

function lsGet<T>(key: string, maxAgeMs: number): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { at, v } = JSON.parse(raw) as { at: number; v: T };
    return Date.now() - at < maxAgeMs ? v : null;
  } catch {
    return null;
  }
}

function lsSet(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), v }));
  } catch {
    /* storage full or blocked */
  }
}

/** Base assets with a USDT spot pair, most traded first. Cached for a day. */
export async function getSymbols(): Promise<string[]> {
  const cached = lsGet<string[]>('gd:symbols', 864e5);
  if (cached?.length) return cached;
  const rows = await getJSON<{ symbol: string; quoteVolume: string }[]>(`${BIN}/ticker/24hr?type=MINI`);
  const list = rows
    .filter((r) => r.symbol.endsWith('USDT'))
    .map((r) => ({ base: r.symbol.slice(0, -4), vol: +r.quoteVolume }))
    .filter((r) => r.base && !STABLES.has(r.base) && !/(UP|DOWN|BULL|BEAR)$/.test(r.base) && r.vol > 0)
    .sort((a, b) => b.vol - a.vol)
    .map((r) => r.base);
  lsSet('gd:symbols', list);
  return list;
}

export interface FngPoint {
  t: number;
  v: number;
  label: string;
}

/** Crypto Fear & Greed Index (Alternative.me), oldest first. Cached for an hour. */
export async function getFearGreed(): Promise<FngPoint[]> {
  const cached = lsGet<FngPoint[]>('gd:fng', 36e5);
  if (cached?.length) return cached;
  const res = await getJSON<{ data: { value: string; value_classification: string; timestamp: string }[] }>(FNG);
  const pts = res.data
    .map((d) => ({ t: +d.timestamp, v: +d.value, label: d.value_classification }))
    .filter((d) => Number.isFinite(d.t) && Number.isFinite(d.v))
    .sort((a, b) => a.t - b.t);
  lsSet('gd:fng', pts);
  return pts;
}
