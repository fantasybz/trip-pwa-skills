// fsa.test.ts — Bun unit tests for the ②-A.1 File System Access write-back layer.
//
// Lives in templates/js-tests/ (NOT templates/js/) — a colocated *.test.ts in
// js/ would be copied into the scaffolded trip and tripped on by regenerate-sw's
// js/*.js classifier. Covers the pure/injectable surface: fsaSupported() gating
// and writeFiles() ordering + degradation. The real FSA semantics (transient
// activation, permission persistence, structured-clone handle, createWritable on
// a real disk) cannot run headless — they are the manual smoke checklist (T8).

import { test, expect, afterEach } from 'bun:test';
import { fsaSupported, writeFiles } from '../js/fsa.js';

// ---- fsaSupported() matrix (Q3) ---------------------------------------------
const origWindow = (globalThis as any).window;
afterEach(() => { (globalThis as any).window = origWindow; });
function setWindow(w: any) { (globalThis as any).window = w; }
function win(over: any = {}) {
  return { showDirectoryPicker() {}, isSecureContext: true, location: { hostname: 'localhost' }, ...over };
}

test('fsaSupported: localhost + secure + API → true', () => {
  setWindow(win());
  expect(fsaSupported()).toBe(true);
});
test('fsaSupported: 127.0.0.1 → true', () => {
  setWindow(win({ location: { hostname: '127.0.0.1' } }));
  expect(fsaSupported()).toBe(true);
});
test('fsaSupported: no showDirectoryPicker → false', () => {
  setWindow(win({ showDirectoryPicker: undefined }));
  expect(fsaSupported()).toBe(false);
});
test('fsaSupported: insecure context → false', () => {
  setWindow(win({ isSecureContext: false }));
  expect(fsaSupported()).toBe(false);
});
test('fsaSupported: non-localhost host (gh-pages) → false', () => {
  setWindow(win({ location: { hostname: 'fantasybz.github.io' } }));
  expect(fsaSupported()).toBe(false);
});
test('fsaSupported: window undefined → false', () => {
  setWindow(undefined);
  expect(fsaSupported()).toBe(false);
});

// ---- writeFiles() ordering + degradation (D6 / #3 / #8) ---------------------
// A mock FileSystemDirectoryHandle that records write order and can be told to
// fail getFileHandle (missing), write(), or close() for specific files.
function mockDir(opts: { missing?: string[]; failWrite?: string[]; failClose?: string[] } = {}) {
  const writes: Record<string, string> = {};
  const order: string[] = [];
  let aborted = 0;
  const dir = {
    async getFileHandle(name: string) {
      if (opts.missing?.includes(name)) throw new Error('NotFoundError');
      return {
        async createWritable() {
          let buf = '';
          return {
            async write(c: string) {
              if (opts.failWrite?.includes(name)) throw new Error('write fail');
              buf += c;
            },
            async close() {
              if (opts.failClose?.includes(name)) throw new Error('close fail');
              writes[name] = buf; order.push(name);
            },
            async abort() { aborted++; },
          };
        },
      };
    },
  };
  return { dir, writes, order, aborted: () => aborted };
}

test('writeFiles writes corpus files BEFORE feed_candidates.json (order invariant)', async () => {
  const m = mockDir();
  const res = await writeFiles(m.dir as any, {
    'feed_candidates.json': '[]\n', 'food.json': '[]\n', 'desserts.json': '[]\n',
  });
  expect(res.ok).toBe(true);
  expect(m.order[m.order.length - 1]).toBe('feed_candidates.json');
});

test('writeFiles: corpus write fails → feed_candidates is NOT written (#3 abort-before-removal)', async () => {
  const m = mockDir({ failWrite: ['food.json'] });
  const res = await writeFiles(m.dir as any, { 'food.json': 'x', 'feed_candidates.json': 'y' });
  expect(res.ok).toBe(false);
  expect(res.failed).toContain('food.json');
  expect(res.failed).toContain('feed_candidates.json');     // skipped → candidate stays on disk
  expect(m.writes['feed_candidates.json']).toBeUndefined();
  expect(m.aborted()).toBe(1);                              // #8 partial stream aborted, not closed
});

test('writeFiles: missing file degrades that file, others still write', async () => {
  const m = mockDir({ missing: ['attractions.json'] });
  const res = await writeFiles(m.dir as any, { 'food.json': 'A', 'attractions.json': 'B' });
  expect(res.written).toContain('food.json');
  expect(res.failed).toContain('attractions.json');
  expect(m.writes['food.json']).toBe('A');
});

test('writeFiles: close() failure counts as a write failure (#8 close = commit point)', async () => {
  const m = mockDir({ failClose: ['food.json'] });
  const res = await writeFiles(m.dir as any, { 'food.json': 'A' });
  expect(res.ok).toBe(false);
  expect(res.failed).toContain('food.json');
});

test('writeFiles: no handle → all failed, never throws', async () => {
  const res = await writeFiles(null as any, { 'food.json': 'A' });
  expect(res.ok).toBe(false);
  expect(res.failed).toContain('food.json');
});

test('writeFiles: empty map → ok with nothing written', async () => {
  const m = mockDir();
  const res = await writeFiles(m.dir as any, {});
  expect(res.ok).toBe(true);
  expect(res.written.length).toBe(0);
});
