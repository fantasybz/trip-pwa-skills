// regenerate-sw.test.ts — Run: bun test skills/_lib/regenerate-sw.test.ts
import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { regenerateServiceWorker } from './regenerate-sw';

// Minimal scaffolded trip with the cacheable file families regenerate-sw knows.
async function makeTrip(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'trip-sw-'));
  await mkdir(join(dir, 'css'), { recursive: true });
  await mkdir(join(dir, 'js'), { recursive: true });
  await mkdir(join(dir, 'data'), { recursive: true });
  await writeFile(join(dir, 'index.html'), '<!doctype html>');
  await writeFile(join(dir, 'css', 'app.css'), 'body{}');
  await writeFile(join(dir, 'js', 'app.js'), '//');
  await writeFile(join(dir, 'data', 'trip.json'), JSON.stringify({ dates: { start: '2026-08-01' } }));
  await writeFile(join(dir, 'data', 'days.json'), '[]');
  return dir;
}

test('ignores stray dotfiles (.gstack/.DS_Store) instead of hard-erroring (A2 dogfood / codex P2-c)', async () => {
  const dir = await makeTrip();
  try {
    // dotfiles a browse / editor tool might drop into the trip dir
    await mkdir(join(dir, '.gstack'), { recursive: true });
    await writeFile(join(dir, '.gstack', 'audit.jsonl'), '{}');
    await writeFile(join(dir, '.DS_Store'), 'x');
    const m = await regenerateServiceWorker(dir);          // must NOT throw
    const all = [...m.shell, ...m.content, ...m.optional];
    expect(all.some((p) => p.includes('.gstack'))).toBe(false);
    expect(all.some((p) => p.includes('.DS_Store'))).toBe(false);
    expect(m.content).toContain('./data/days.json');       // real content still cached
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('generated sw.js auto-skipWaiting so a fresh ingest shows on next reload (dogfood C3)', async () => {
  const dir = await makeTrip();
  try {
    await regenerateServiceWorker(dir);
    const sw = await readFile(join(dir, 'sw.js'), 'utf8');
    expect(sw).toContain('self.skipWaiting()');
    expect(sw).toContain("self.clients.claim()");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('still hard-errors on a genuinely-unclassified shipped file (dot-skip did not over-broaden)', async () => {
  const dir = await makeTrip();
  try {
    await writeFile(join(dir, 'mystery.xyz'), 'x');         // not a dotfile, not a known bucket
    await expect(regenerateServiceWorker(dir)).rejects.toThrow(/unclassified/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
