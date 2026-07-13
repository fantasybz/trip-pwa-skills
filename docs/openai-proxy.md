# Using an OpenAI key for AI enrich (the proxy on-ramp)

The generated PWA's ②-B AI enrich (✏️ 編輯 → AI 起草 why_picked) is **BYOK** — you
bring your own key, you pay your own bill, the key lives only in the tab's
`sessionStorage`. Two providers, routed by key prefix:

| key prefix | provider | works in the browser? |
|---|---|---|
| `sk-ant-…` | Anthropic | **yes, directly** — no setup |
| `sk-…` (anything else) | OpenAI | **only through a CORS proxy you control** |

If you have an Anthropic key, stop here — paste it and go. **This doc is only for
OpenAI keys.**

## Why OpenAI needs a proxy

A PWA served from `https://you.github.io` calling `https://api.openai.com` is a
cross-origin request. The browser blocks it unless OpenAI returns
`Access-Control-Allow-Origin` — and **OpenAI doesn't** (verified 2026-06-14).
Anthropic offers an opt-in `anthropic-dangerous-direct-browser-access` header for
exactly this; OpenAI has no equivalent. So an OpenAI key can only reach the API
through a **CORS-enabled, OpenAI-compatible base URL that you control**.

The scaffold bakes that base into the app's CSP + a `<meta>` tag at build time
(not at runtime — a runtime-editable base would mean a blanket CSP and a
key-routing footgun). Without it, an OpenAI key fails fast with a clear message;
nothing ever leaves the page toward a doomed host.

## Option A — Cloudflare Worker (recommended, free)

A 60-line Worker that adds the CORS headers and forwards **only**
`POST /v1/chat/completions` to OpenAI. Your key rides in the request the browser
already sends; the Worker never stores, logs, or hardcodes it.

```bash
npm i -g wrangler && wrangler login
# copy docs/openai-cors-worker.js into a new project as src/index.js,
# set ALLOWED_ORIGIN to your PWA origin (e.g. https://you.github.io), then:
wrangler deploy            # → https://<name>.<you>.workers.dev
```

Then scaffold the trip pointing at it:

```bash
bun skills/_lib/scaffold.ts --city Seoul --city-jp 首爾 --days 5 \
  --lang zh-tw --start 2026-08-01 --out ~/seoul-trip \
  --openai-proxy https://<name>.<you>.workers.dev
```

The Worker source is [`openai-cors-worker.js`](./openai-cors-worker.js).

## Option B — OpenRouter (no Worker to run)

[OpenRouter](https://openrouter.ai) is an OpenAI-compatible gateway that **does**
send CORS headers, so it needs no Worker — just point the proxy at its base. Use
an OpenRouter key (`sk-or-…`, still an `sk-` prefix → routed as OpenAI):

```bash
bun skills/_lib/scaffold.ts ... --openai-proxy https://openrouter.ai/api/v1
```

`resolveOpenAiChatUrl` already understands the `/api/v1` shape. Trade-off: your
key + the few-shot/venue content transit OpenRouter, a third party — fine for a
personal trip list, your call for anything sensitive.

## What `--openai-proxy` accepts

`resolveOpenAiChatUrl` (in `templates/js/ai.js`, the same validator scaffold
reuses) is deliberately strict — the BYOK key is sent as `Authorization` to this
host:

- **https only** (loopback `http://localhost` allowed for dev)
- **not** `api.openai.com` (that's the CORS-blocked host this works around)
- no embedded credentials, no query string, no hash
- path must be a root, `…/v1`, or a full `…/chat/completions` — never a guessed
  subpath

Anything else exits non-zero at scaffold time with the reason.

## Verify it works

After deploy + scaffold + publish: open the PWA, ✏️ 編輯 → AI 起草, paste your
OpenAI key. In DevTools → Network you should see the enrich `POST` go to your
**proxy host** (not api.openai.com), return 200, and zero CSP violations in the
console. The key-entry sheet also shows which host an OpenAI key would be sent to,
so there's no silent exfiltration.

## Security model (recap)

- Your key is sent to **your** proxy. Don't point `--openai-proxy` at a proxy you
  don't control — its operator would see your key and prompts.
- The Worker in Option A is **not an open relay**: one endpoint, POST only, your
  origin only.
- The key never touches `localStorage`, the service worker, the exported corpus,
  or any log — same guarantees as the Anthropic path (see `ai.js` SECURITY notes).
