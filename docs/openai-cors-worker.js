// openai-cors-worker.js — minimal BYOK CORS proxy for the trip PWA's OpenAI enrich.
//
// WHY: api.openai.com sends no CORS headers, so a browser PWA can't call it
// directly (Anthropic CAN, via its dangerous-direct-browser-access header; OpenAI
// can't — verified 2026-06-14). This Worker adds the CORS headers the browser
// needs and forwards the request — and ONLY that one request — to OpenAI. The
// user's OpenAI key rides in the Authorization header the browser already sends
// (BYOK); this Worker NEVER stores, logs, or hardcodes a key.
//
// DEPLOY (Cloudflare Workers, free tier):
//   1. npm i -g wrangler && wrangler login
//   2. set ALLOWED_ORIGIN below to YOUR PWA origin (e.g. https://you.github.io)
//   3. wrangler deploy        → https://<name>.<you>.workers.dev
//   4. trip-scaffold init ... --openai-proxy https://<name>.<you>.workers.dev
//
// SECURITY: this is NOT an open proxy. It forwards POST /v1/chat/completions to
// api.openai.com ONLY, and answers CORS only for ALLOWED_ORIGIN — anything else
// 403s/404s. See docs/openai-proxy.md for the full rationale.

const OPENAI = 'https://api.openai.com';
const ALLOWED_ORIGIN = 'https://YOUR-USERNAME.github.io';   // ← your PWA origin, exact, no trailing slash
const ALLOWED_PATH = '/v1/chat/completions';

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '86400',
    'vary': 'Origin',
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    // CORS preflight — only for the allowed origin
    if (request.method === 'OPTIONS') {
      return origin === ALLOWED_ORIGIN
        ? new Response(null, { status: 204, headers: corsHeaders(origin) })
        : new Response(null, { status: 403 });
    }

    // exactly one endpoint, POST only, allowed origin only — never an open relay
    if (request.method !== 'POST' || url.pathname !== ALLOWED_PATH) return new Response('not found', { status: 404 });
    if (origin !== ALLOWED_ORIGIN) return new Response('forbidden', { status: 403 });

    // forward the BYOK request to OpenAI (Authorization + body pass through; no logging)
    const upstream = await fetch(OPENAI + ALLOWED_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: request.headers.get('Authorization') || '',
      },
      body: await request.text(),
    });

    // relay OpenAI's status + body, add CORS so the browser can read the result
    const headers = new Headers(corsHeaders(origin));
    headers.set('content-type', upstream.headers.get('content-type') || 'application/json');
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
