// ai-validate.js — the ②-B runtime trust boundary for AI-drafted venue fields.
//
// AI output is UNTRUSTED (the model read attacker-influenceable caption/name text).
// This module is the shipped-in-bundle gate that build-time integrity tests cannot
// be (they don't run in a deployed browser). It VALIDATES-and-REJECTS; it does NOT
// encode — esc() at render time is the encoder (Codex#7). Storing esc()-ed text
// would double-escape at paint, so we store the RAW validated string.
//
// Plain ES module (NOT TypeScript) — js/*.js are loaded verbatim by the browser.
//
// CONTRACT (D4 — strict allowlist, NOT a denylist):
//   validateDraft(raw) ->
//     { ok: true,  fields: { why_picked: string, kid_friendly?: boolean } }
//     { ok: false, reason: string }   // reason is a stable code for the UI/tests
//   It extracts ONLY why_picked (+ optional kid_friendly); ANY other property the
//   model returns is dropped on the floor — it can never reach the overlay, so the
//   BYOK key (or a smuggled <script>/url field) cannot ride into a corpus.
//
// The accept path then merges { ...currentEntry, why_picked } (spread the CURRENT
// full entry — NEVER buildVenueEntry(), which rebuilds a narrow schema and drops
// fields, Codex#4), and sets kid_friendly ONLY when this module reports it present
// (presence-aware, Codex#5).

// A why_picked is 1-3 short sentences. 240 chars mirrors the corpus tip-text cap
// (~120 CJK chars) — generous for the family-lens line, tight enough to cap a
// poisoned-caption blow-up that slipped past max_tokens.
export const MAX_WHY_PICKED_LEN = 240;
export const MIN_WHY_PICKED_LEN = 4;

// Markdown idioms the renderer does NOT parse (it renders plain text via esc()),
// so they leak as literal characters to the user (the markdown_render rule, ported
// to a runtime guard). Reject any draft that contains them.
const MARKDOWN_PATTERNS = [
  ['bold-or-italic-star', /\*\S/],          // **bold** / *italic*
  ['inline-code', /`/],                      // `code`
  ['md-link', /\[[^\]]*\]\([^)]*\)/],        // [text](url)
  ['heading', /(^|\n)\s{0,3}#{1,6}\s/],      // # heading
  ['blockquote', /(^|\n)\s{0,3}>\s/],        // > quote
  ['cross-ref', /\[\[[^\]]+\]\]/],           // [[tip-id]] — main-repo only, not valid here
];

// C0 control chars except \t (\x09) and \n (\x0A), plus DEL (\x7F). A model should
// never emit these in a short prose line; their presence signals a garbled or
// adversarial response.
const CONTROL_CHARS = /[\x00-\x08\x0B-\x1F\x7F]/;

// HTML TAG detection (defense in depth alongside render-time esc()). Match '<'
// followed by a letter, '/', or '!' — i.e. <b>, </div>, <!--. We deliberately do
// NOT reject a bare '<' or '>' (a parent legitimately writes "排隊 > 30 分鐘" /
// "等位 < 10 分"); render-time esc() makes those safe, so only tag-shaped input is
// suspicious enough to reject the draft.
const HTML_TAG = /<[a-z!/]/i;

function reject(reason) { return { ok: false, reason }; }

// Validate ONE AI draft object (the tool_use input, already parsed). `raw` is
// whatever the model returned for the structured tool call.
export function validateDraft(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return reject('not-an-object');

  // --- why_picked (required) ---
  const wp = raw.why_picked;
  if (typeof wp !== 'string') return reject('why_picked-not-string');
  const trimmed = wp.trim();
  if (trimmed.length < MIN_WHY_PICKED_LEN) return reject('why_picked-too-short');
  if (trimmed.length > MAX_WHY_PICKED_LEN) return reject('why_picked-too-long');
  if (CONTROL_CHARS.test(wp)) return reject('control-chars');
  if (HTML_TAG.test(wp)) return reject('html-markup');
  for (const [code, re] of MARKDOWN_PATTERNS) {
    if (re.test(wp)) return reject(`markdown:${code}`);
  }

  const fields = { why_picked: trimmed };

  // --- kid_friendly (optional, food only; presence-aware) ---
  // Include ONLY when the model explicitly returned a real boolean. If it's absent
  // the accept path leaves the existing value untouched (Codex#5 — never flip an
  // existing true to false because the model omitted the key). A present-but-
  // non-boolean value is a malformed response → reject the whole draft.
  if (Object.prototype.hasOwnProperty.call(raw, 'kid_friendly')) {
    if (typeof raw.kid_friendly !== 'boolean') return reject('kid_friendly-not-boolean');
    fields.kid_friendly = raw.kid_friendly;
  }

  return { ok: true, fields };
}

// Merge a validated draft onto the CURRENT full entry for the accept path.
// CRITICAL (Codex#4): spread the current entry and overlay ONLY why_picked —
// do NOT route through buildVenueEntry(), which rebuilds a narrow fixed schema
// and DROPS fields outside its fixed corpus schema (anchor / backup_fit / coords / …) and
// coerces kid_friendly with `!!`. CRITICAL (Codex#5): set kid_friendly ONLY when
// the validated fields actually carry it (presence-aware) — never flip an
// existing `true` to `false` because the model omitted the key. `acceptedText`
// (optional) is the human-edited textarea value at accept time; when present it
// wins over the AI's why_picked (the human is the final author).
export function applyDraftToEntry(currentEntry, fields, acceptedText) {
  const cur = currentEntry && typeof currentEntry === 'object' ? currentEntry : {};
  const f = fields && typeof fields === 'object' ? fields : {};
  const next = { ...cur };
  const wp = typeof acceptedText === 'string' ? acceptedText : f.why_picked;
  if (typeof wp === 'string') next.why_picked = wp;
  if (Object.prototype.hasOwnProperty.call(f, 'kid_friendly')) next.kid_friendly = f.kid_friendly;
  return next;
}
