// sanitize.test.ts — Bun unit tests for the shared escaper + URL guards (②-B D3=C).
//
// Lives in templates/js-tests/ (NOT templates/js/) — a colocated *.test.ts in js/
// would be copied into the scaffolded trip and tripped on by regenerate-sw's
// js/*.js classifier. sanitize.js is the leaf module render.js / edit-mode.js /
// ai-validate.js all import; these tests are the parity + XSS-guard contract.

import { test, expect } from 'bun:test';
import { esc, isHttpUrl, safeUrl } from '../js/sanitize.js';

// ---- esc(): the OUTPUT encoder ----------------------------------------------
test('esc escapes the 5 HTML-significant chars', () => {
  expect(esc('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;');
});
test('esc neutralizes a script-injection payload', () => {
  expect(esc('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
});
test('esc leaves safe text (incl. CJK) untouched', () => {
  expect(esc('帶 5 歲小孩很適合')).toBe('帶 5 歲小孩很適合');
});
test('esc coerces non-string input without throwing', () => {
  expect(esc(42 as any)).toBe('42');
  expect(esc(null as any)).toBe('null');
  expect(esc(undefined as any)).toBe('undefined');
});
test('esc on empty string is empty', () => {
  expect(esc('')).toBe('');
});

// ---- isHttpUrl(): strict boolean scheme guard (full URL, no base) -----------
test('isHttpUrl accepts http + https', () => {
  expect(isHttpUrl('http://example.com')).toBe(true);
  expect(isHttpUrl('https://example.com/path?q=1')).toBe(true);
});
test('isHttpUrl rejects dangerous + non-http schemes', () => {
  expect(isHttpUrl('javascript:alert(1)')).toBe(false);
  expect(isHttpUrl('data:text/html,<script>')).toBe(false);
  expect(isHttpUrl('mailto:a@b.com')).toBe(false);
  expect(isHttpUrl('ftp://host/f')).toBe(false);
});
test('isHttpUrl rejects scheme-less / relative / garbage', () => {
  expect(isHttpUrl('example.com')).toBe(false);   // no scheme → URL ctor throws
  expect(isHttpUrl('/path/only')).toBe(false);
  expect(isHttpUrl('')).toBe(false);
  expect(isHttpUrl('not a url')).toBe(false);
});

// ---- safeUrl(): href sanitizer — returns the URL or inert '#' ---------------
test('safeUrl passes http(s) through (absolute)', () => {
  expect(safeUrl('https://maps.google.com/?q=x')).toBe('https://maps.google.com/?q=x');
  expect(safeUrl('http://a.test/')).toBe('http://a.test/');
});
test('safeUrl renders dangerous schemes inert', () => {
  expect(safeUrl('javascript:alert(1)')).toBe('#');
  expect(safeUrl('data:text/html,<script>alert(1)</script>')).toBe('#');
  expect(safeUrl('vbscript:msgbox(1)')).toBe('#');
});
test('safeUrl resolves a relative URL against an explicit base', () => {
  expect(safeUrl('/maps/x', 'https://host.test')).toBe('https://host.test/maps/x');
});
test('safeUrl returns # for unparseable input (no base in test env)', () => {
  expect(safeUrl('::::')).toBe('#');
  expect(safeUrl('')).toBe('#');
});
