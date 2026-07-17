// regenerate-sw.test.ts — Run: bun test skills/_lib/regenerate-sw.test.ts
import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { regenerateServiceWorker } from './regenerate-sw';
import { acquireTripWriteLock } from './safe-trip-write';

const regenerateCli = fileURLToPath(new URL('./regenerate-sw.ts', import.meta.url));

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

for (const separator of ['\u2028', '\u2029']) {
  test(`encodes cache filenames containing U+${separator.codePointAt(0)!.toString(16).toUpperCase()} as parseable JS`, async () => {
    const dir = await makeTrip();
    try {
      const hostileName = `quote-'\\-${separator}.js`;
      await writeFile(join(dir, 'js', hostileName), '// filename is data, never source');
      const manifest = await regenerateServiceWorker(dir);
      const sw = await readFile(join(dir, 'sw.js'), 'utf8');
      const encoded = JSON.stringify(`./js/${hostileName}`)
        .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
      expect(manifest.shell).toContain(`./js/${hostileName}`);
      expect(sw).toContain(encoded);
      expect(() => new Function(sw)).not.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('rejects an invalid trip start date before generating executable SW source', async () => {
  const dir = await makeTrip();
  try {
    await writeFile(join(dir, 'data', 'trip.json'), JSON.stringify({
      dates: { start: "2026-08-01';self.pwned=true;//" },
    }));
    await expect(regenerateServiceWorker(dir)).rejects.toThrow(/dates\.start must be a real ISO date/);
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

test('CLI regenerates after a direct data edit and prints the version', async () => {
  const dir = await makeTrip();
  try {
    const result = spawnSync('bun', [regenerateCli, '--out', dir], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/sw\.js regenerated \(2026-08-01-/);
    expect((await readFile(join(dir, 'sw.js'), 'utf8')).length).toBeGreaterThan(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('recovery CLI requires an explicit --out value', () => {
  for (const args of [[], ['--out'], ['--out', '--other']]) {
    const result = spawnSync('bun', [regenerateCli, ...args], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Required: --out <trip dir>');
  }
});

test('direct recovery CLI refuses to race an active trip writer', async () => {
  const dir = await makeTrip();
  try {
    const release = await acquireTripWriteLock(dir);
    const result = spawnSync('bun', [regenerateCli, '--out', dir], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('another trip write is in progress');
    expect(await readFile(join(dir, 'data', 'days.json'), 'utf8')).toBe('[]');
    await release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects a symlinked sw.js instead of overwriting its external target', async () => {
  const dir = await makeTrip();
  const victim = `${dir}-victim.txt`;
  try {
    await writeFile(victim, 'do not overwrite');
    await symlink(victim, join(dir, 'sw.js'));
    await expect(regenerateServiceWorker(dir)).rejects.toThrow(/symlinked shipped path/);
    expect(await readFile(victim, 'utf8')).toBe('do not overwrite');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(victim, { force: true });
  }
});
