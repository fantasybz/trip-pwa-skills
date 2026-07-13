// sanitize.js — shared output-encoding + URL-safety leaf module (②-B D3=C).
//
// ONE home for the HTML escaper and the URL guards that render.js, edit-mode.js,
// and ai-validate.js (the ②-B AI runtime validator) all need. Before this module
// the escaper lived twice (render.js `escapeHtml` + edit-mode.js `esc`) and the
// URL check thrice (render.js `safeUrl`, edit-mode.js `isHttpUrl`, inline) — a
// change to the escape rule had to be mirrored by hand, one missed copy = an XSS
// hole. Leaf module: NO imports, so anything may depend on it without a cycle.
//
// IMPORTANT (②-B): `esc()` is an OUTPUT ENCODER, not a validator. It makes a
// string safe to interpolate into innerHTML at PAINT time. It does NOT decide
// whether a value is acceptable to STORE — that is ai-validate.js's job, which
// validates-and-rejects (type/length/markdown/HTML) and stores the RAW string;
// the render layer escapes on the way out. Storing esc()-ed text would
// double-escape at paint. Keep the two concerns separate.

// HTML-escape the 5 dangerous chars for innerHTML interpolation. String() guards
// non-string input (numbers, null) so a caller can't blow up the renderer.
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Strict boolean http(s) scheme guard for a FULL url (no base). A scheme-less or
// relative string (`example.com`, `/path`) throws in the URL ctor → false; a
// `javascript:` / `data:` / `mailto:` scheme parses but is not http(s) → false.
// Used by edit-mode.js to decide whether a pasted string is a usable source URL.
export function isHttpUrl(u) {
  try { const p = new URL(u).protocol; return p === 'http:' || p === 'https:'; }
  catch { return false; }
}

// Sanitize a URL for use in an href. esc() does NOT neutralize a javascript:/data:
// scheme — parse (resolving relatives against the page origin) and whitelist
// http(s) only. Returns '#' for anything unsafe so the link is inert, not
// executable. `base` defaults to the document location when available (browser);
// pass an explicit base in non-DOM contexts (tests) to resolve relatives.
export function safeUrl(raw, base) {
  const b = base || (typeof location !== 'undefined' ? location.href : undefined);
  try {
    const u = new URL(String(raw), b);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : '#';
  } catch (_) {
    return '#';
  }
}
