// ai-validate.test.ts — Bun unit tests for the ②-B runtime trust boundary.
//
// Lives in templates/js-tests/ (NOT templates/js/) so regenerate-sw's js/*.js
// classifier never sees it. This is the gate that keeps untrusted AI output from
// reaching a corpus, so it gets heavy edge + adversarial coverage.

import { test, expect } from 'bun:test';
import { validateDraft, applyDraftToEntry, MAX_WHY_PICKED_LEN, MIN_WHY_PICKED_LEN } from '../js/ai-validate.js';

const GOOD = '有兒童椅且離車站近,店內動線寬敞不擁擠,適合帶 5 歲小孩的家庭。';

// ---- happy path -------------------------------------------------------------
test('valid draft → ok with trimmed why_picked', () => {
  const r = validateDraft({ why_picked: `  ${GOOD}  ` });
  expect(r.ok).toBe(true);
  expect(r.fields.why_picked).toBe(GOOD);          // trimmed
  expect('kid_friendly' in r.fields).toBe(false);  // absent → omitted
});

// ---- strict allowlist: the security crux -----------------------------------
test('extra fields are DROPPED — key/script/url cannot ride into the overlay', () => {
  const r = validateDraft({
    why_picked: GOOD,
    apiKey: 'sk-ant-LEAK',
    key: 'sk-ant-LEAK2',
    source_url: 'javascript:alert(1)',
    note: '<script>alert(1)</script>',
    id: 'evil',
  });
  expect(r.ok).toBe(true);
  expect(Object.keys(r.fields).sort()).toEqual(['why_picked']);  // ONLY why_picked
  expect((r.fields as any).apiKey).toBeUndefined();
  expect((r.fields as any).key).toBeUndefined();
});

// ---- shape rejection --------------------------------------------------------
test('non-object inputs are rejected', () => {
  for (const bad of [null, undefined, 'str', 42, [], [{ why_picked: GOOD }]]) {
    expect(validateDraft(bad as any).ok).toBe(false);
  }
});
test('missing / non-string why_picked rejected', () => {
  expect(validateDraft({}).reason).toBe('why_picked-not-string');
  expect(validateDraft({ why_picked: 123 }).reason).toBe('why_picked-not-string');
  expect(validateDraft({ why_picked: null }).reason).toBe('why_picked-not-string');
});

// ---- length boundaries ------------------------------------------------------
test('too-short why_picked rejected', () => {
  expect(validateDraft({ why_picked: 'a' }).reason).toBe('why_picked-too-short');
  expect(validateDraft({ why_picked: '   ' }).reason).toBe('why_picked-too-short');
});
test('length boundary: exactly MIN passes, MAX passes, MAX+1 rejected', () => {
  expect(validateDraft({ why_picked: 'x'.repeat(MIN_WHY_PICKED_LEN) }).ok).toBe(true);
  expect(validateDraft({ why_picked: 'x'.repeat(MAX_WHY_PICKED_LEN) }).ok).toBe(true);
  expect(validateDraft({ why_picked: 'x'.repeat(MAX_WHY_PICKED_LEN + 1) }).reason).toBe('why_picked-too-long');
});

// ---- markdown leak class (ported markdown_render rule) ----------------------
test('markdown idioms rejected (would leak as literal chars)', () => {
  expect(validateDraft({ why_picked: '這家**超讚**適合小孩' }).reason).toBe('markdown:bold-or-italic-star');
  expect(validateDraft({ why_picked: '用 `code` 標記的店' }).reason).toBe('markdown:inline-code');
  expect(validateDraft({ why_picked: '看 [這裡](http://x.test) 的店家' }).reason).toBe('markdown:md-link');
  expect(validateDraft({ why_picked: '# 大標題當開頭的草稿' }).reason).toBe('markdown:heading');
  expect(validateDraft({ why_picked: '> 引言開頭的草稿內容' }).reason).toBe('markdown:blockquote');
  expect(validateDraft({ why_picked: '看 [[tdl-tip-1]] 這條提示' }).reason).toBe('markdown:cross-ref');
});

// ---- HTML tags / control chars ----------------------------------------------
test('HTML tags rejected (html markup)', () => {
  expect(validateDraft({ why_picked: '適合小孩 <b>很棒</b> 的店家環境' }).reason).toBe('html-markup');
  expect(validateDraft({ why_picked: '看 <a href=x>這裡</a> 的家庭餐廳' }).reason).toBe('html-markup');
});
test('bare < / > as comparison is ALLOWED (no false positive)', () => {
  // render esc()s these at paint; a parent legitimately writes math/comparison.
  expect(validateDraft({ why_picked: '排隊通常 < 10 分鐘,份量 > 一般,適合帶小孩' }).ok).toBe(true);
});
test('control chars rejected, but tab/newline allowed', () => {
  expect(validateDraft({ why_picked: `bad\x00null byte here padding` }).reason).toBe('control-chars');
  expect(validateDraft({ why_picked: `行一\n行二,適合帶小孩的家庭餐廳` }).ok).toBe(true);
});

// ---- kid_friendly: presence-aware (Codex#5) ---------------------------------
test('kid_friendly boolean is included when present', () => {
  expect(validateDraft({ why_picked: GOOD, kid_friendly: true }).fields).toEqual({ why_picked: GOOD, kid_friendly: true });
  expect(validateDraft({ why_picked: GOOD, kid_friendly: false }).fields).toEqual({ why_picked: GOOD, kid_friendly: false });
});
test('kid_friendly absent → omitted (accept path leaves existing untouched)', () => {
  expect('kid_friendly' in validateDraft({ why_picked: GOOD }).fields).toBe(false);
});
test('kid_friendly present-but-non-boolean → whole draft rejected', () => {
  expect(validateDraft({ why_picked: GOOD, kid_friendly: 'yes' }).reason).toBe('kid_friendly-not-boolean');
  expect(validateDraft({ why_picked: GOOD, kid_friendly: 1 }).reason).toBe('kid_friendly-not-boolean');
});

// ---- applyDraftToEntry: the accept-merge (Codex#4/#5) -----------------------
test('applyDraftToEntry preserves ALL current fields, overlays only why_picked', () => {
  const cur = { id: 'f1', name_zh: '小樹屋', name_jp_or_local: 'こだち', anchor: '淺草', backup_fit: '雨備', why_picked: '舊的', kid_friendly: true };
  const out = applyDraftToEntry(cur, { why_picked: GOOD });
  expect(out.id).toBe('f1');
  expect(out.name_jp_or_local).toBe('こだち');     // NOT dropped (the buildVenueEntry trap)
  expect(out.anchor).toBe('淺草');
  expect(out.backup_fit).toBe('雨備');
  expect(out.why_picked).toBe(GOOD);               // overlaid
  expect(out.kid_friendly).toBe(true);             // untouched (draft omitted it)
});
test('applyDraftToEntry: kid_friendly omitted → existing true PRESERVED (no flip)', () => {
  const out = applyDraftToEntry({ id: 'f1', kid_friendly: true }, { why_picked: GOOD });
  expect(out.kid_friendly).toBe(true);
});
test('applyDraftToEntry: kid_friendly present → set (even to false)', () => {
  const out = applyDraftToEntry({ id: 'f1', kid_friendly: true }, { why_picked: GOOD, kid_friendly: false });
  expect(out.kid_friendly).toBe(false);
});
test('applyDraftToEntry: human-edited acceptedText wins over AI why_picked', () => {
  const out = applyDraftToEntry({ id: 'f1' }, { why_picked: GOOD }, '我自己改寫的版本,更貼近我家小孩');
  expect(out.why_picked).toBe('我自己改寫的版本,更貼近我家小孩');
});
test('applyDraftToEntry: does not mutate the input entry', () => {
  const cur = { id: 'f1', why_picked: '舊的' };
  applyDraftToEntry(cur, { why_picked: GOOD });
  expect(cur.why_picked).toBe('舊的');             // original untouched (immutable)
});
