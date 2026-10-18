export type TF = '4h' | '1d' | '1w' | '1M';

export interface Bar {
  t: number; // open time, unix seconds (UTC)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface TfInfo {
  label: string;
  binance: string;
  sec: number;        // nominal bar length in seconds
  max: number;        // bars to load
  defaultBars: number; // bars shown on first view
  word: string;       // "this week"
}

export const TFS: Record<TF, TfInfo> = {
  '4h': { label: '4H', binance: '4h', sec: 14400, max: 2000, defaultBars: 180, word: 'this 4H candle' },
  '1d': { label: '1D', binance: '1d', sec: 86400, max: 6000, defaultBars: 320, word: 'today' },
  '1w': { label: '1W', binance: '1w', sec: 604800, max: 1000, defaultBars: 100000, word: 'this week' },
  '1M': { label: '1M', binance: '1M', sec: 2629746, max: 1000, defaultBars: 100000, word: 'this month' },
};

export const TF_ORDER: TF[] = ['4h', '1d', '1w', '1M'];

export interface Pt {
  t: number;
  p: number;
}
