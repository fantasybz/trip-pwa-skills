// url-key.ts — normalize a URL into a stable dedup key (Codex Day-3 P2).
// Exact-string dedup let YouTube variants, tracking params, and trailing slashes
// escape. This collapses the common cases so refs-ingest and launch-check agree.

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'si', 'feature', 'fbclid', 'gclid', 'igshid', 'ref', 'ref_src',
]);

// Return a canonical YouTube video id if this is a YouTube watch/short/youtu.be
// URL, else null.
function youtubeId(u: URL): string | null {
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
  if (host === 'youtube.com' || host === 'm.youtube.com') {
    if (u.pathname === '/watch') return u.searchParams.get('v');
    const m = u.pathname.match(/^\/(?:shorts|embed|v)\/([^/]+)/);
    if (m) return m[1];
  }
  return null;
}

export function urlKey(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { return raw.trim().toLowerCase(); }

  const yt = youtubeId(u);
  if (yt) return `yt:${yt}`;

  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  // strip default ports, hash, tracking params; sort remaining query
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? '?' + params.map(([k, v]) => `${k}=${v}`).join('&') : '';
  const path = u.pathname.replace(/\/+$/, '') || '/';   // strip trailing slash
  const port = (u.port && u.port !== '80' && u.port !== '443') ? `:${u.port}` : '';
  return `${u.protocol}//${host}${port}${path}${query}`.toLowerCase();
}
