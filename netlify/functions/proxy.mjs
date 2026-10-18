// Fallback route for market data when the browser can't call a source directly
// (blocked by CORS or by region). Only the hosts below are allowed.
const ALLOWED = new Set(['data-api.binance.vision', 'api.alternative.me']);

export default async (req) => {
  const raw = new URL(req.url).searchParams.get('url');
  let target;
  try {
    target = new URL(raw ?? '');
  } catch {
    return new Response('Missing or invalid url', { status: 400 });
  }
  if (target.protocol !== 'https:' || !ALLOWED.has(target.hostname)) {
    return new Response('Host not allowed', { status: 403 });
  }
  try {
    const r = await fetch(target, { headers: { accept: 'application/json' } });
    const body = await r.text();
    return new Response(body, {
      status: r.status,
      headers: {
        'content-type': r.headers.get('content-type') ?? 'application/json',
        'cache-control': 'public, max-age=15',
      },
    });
  } catch (err) {
    return new Response(`Upstream request failed: ${err}`, { status: 502 });
  }
};

export const config = { path: '/api/proxy' };
