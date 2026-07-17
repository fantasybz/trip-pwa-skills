import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditContentDepth, auditDupRefs, runBrowserSuite } from './launch-check';
import { startTrustedStaticServer } from './trusted-static-server';

const launchCheck = fileURLToPath(new URL('./launch-check.ts', import.meta.url));

async function makeTrip(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'launch-check-'));
  const out = join(base, 'trip');
  await mkdir(join(out, 'data'), { recursive: true });
  await writeFile(join(out, 'data', 'trip.json'), JSON.stringify({
    dates: { start: '2026-07-20', end: '2026-07-21' },
    travelers: [{ role: 'parent', age_band: 'adult' }, { role: 'child', age_band: 'school' }],
  }));
  const days = [1, 2].map((n) => ({
    id: `day_${n}`,
    date: `2026-07-${19 + n}`,
    schedule: [1, 2, 3, 4].map((i) => ({
      anchor: `Anchor ${n}-${i}`,
      contingency: { alternatives: [{ name: `Backup ${n}-${i}`, reason: 'rain' }] },
    })),
  }));
  await writeFile(join(out, 'data', 'days.json'), JSON.stringify(days));
  await writeFile(join(out, 'data', 'refs.json'), JSON.stringify({
    schedule_refs: {
      day_1: [{ title: 'Ref 1', url: 'https://example.com/1' }, { title: 'Ref 2', url: 'https://example.com/2' }],
      day_2: [{ title: 'Ref 3', url: 'https://example.com/3' }, { title: 'Ref 4', url: 'https://example.com/4' }],
    },
  }));
  for (const corpus of ['food', 'desserts', 'attractions', 'fandom', 'nearby']) {
    const entries = corpus === 'food'
      ? Array.from({ length: 6 }, (_, i) => ({
        id: `venue-${i}`,
        day_keys: [`day_${(i % 2) + 1}`],
        name_zh: i === 0 ? '   ' : `Venue ${i}`, name: i === 0 ? 'Fallback Venue' : undefined,
        why_picked: i === 0 ? '   ' : 'family fit', hook: i === 0 ? 'family fallback' : undefined,
        maps_query: i === 0 ? '   ' : `Venue ${i}`, address: i === 0 ? '1 Main St' : undefined,
        hours: '09:00-18:00',
      })) : [];
    await writeFile(join(out, 'data', `${corpus}.json`), JSON.stringify(entries));
  }
  return out;
}

test('family content-depth profile passes an execution-ready portable floor', async () => {
  const out = await makeTrip();
  try {
    const result = await auditContentDepth(out);
    expect(result.ok).toBe(true);
    expect(result.metrics).toMatchObject({ days: 2, anchors: 8, refs: 4, venues: 6 });
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
});

test('family content-depth catches a skeleton and missing family/ground fields', async () => {
  const out = await makeTrip();
  try {
    await writeFile(join(out, 'data', 'trip.json'), JSON.stringify({
      dates: { start: '2026-07-20', end: '2026-07-21' }, travelers: [{ role: 'parent' }],
    }));
    await writeFile(join(out, 'data', 'days.json'), JSON.stringify([{
      id: 'day_1', schedule: [{ anchor: 'Only anchor', contingency: { alternatives: [] } }],
    }]));
    await writeFile(join(out, 'data', 'refs.json'), JSON.stringify({ schedule_refs: {} }));
    await writeFile(join(out, 'data', 'food.json'), JSON.stringify([{ id: 'thin', name_zh: 'Thin' }]));
    const result = await auditContentDepth(out);
    expect(result.ok).toBe(false);
    expect(result.issues.join('\n')).toMatch(/age_band/);
    expect(result.issues.join('\n')).toMatch(/schedule density/);
    expect(result.issues.join('\n')).toMatch(/named backup \+ reason/);
    expect(result.issues.join('\n')).toMatch(/prep-ref density/);
    expect(result.issues.join('\n')).toMatch(/ground-detail gaps/);

    const cli = spawnSync('bun', [launchCheck, '--out', out, '--quality', 'family', '--no-a11y'], { encoding: 'utf8' });
    expect(cli.status).toBe(1);
    expect(cli.stderr).toContain('content-depth');
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
});

test('family profile rejects shape-coerced anchors, empty refs, and object-valued venue fields', async () => {
  const out = await makeTrip();
  try {
    const days = [1, 2].map((n) => ({
      id: `day_${n}`,
      schedule: Array.from({ length: 4 }, () => ({
        anchor: {}, contingency: { alternatives: [{ name: {}, reason: {} }] },
      })),
    }));
    await writeFile(join(out, 'data', 'days.json'), JSON.stringify(days));
    await writeFile(join(out, 'data', 'refs.json'), JSON.stringify({
      schedule_refs: {
        day_1: [{}, { title: 'x', url: {} }],
        day_2: [{ title: 'x', url: 'javascript:alert(1)' }, {}],
      },
    }));
    await writeFile(join(out, 'data', 'food.json'), JSON.stringify(Array.from({ length: 6 }, (_, i) => ({
      id: `bad-${i}`, name_zh: {}, why_picked: {}, maps_query: {}, hours: {},
    }))));
    const result = await auditContentDepth(out);
    expect(result.ok).toBe(false);
    expect(result.metrics.refs).toBe(0);
    expect(result.issues.join('\n')).toMatch(/title \+ http\(s\) URL/);
    expect(result.issues.join('\n')).toMatch(/ground-detail gaps/);
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
});

test('family profile rejects date/day mismatches, blank or duplicate ids, and uses the planned span for density', async () => {
  const out = await makeTrip();
  try {
    await writeFile(join(out, 'data', 'trip.json'), JSON.stringify({
      dates: { start: '2026-07-20', end: '2026-07-26' },
      travelers: [{ role: 'parent', age_band: 'adult' }],
    }));
    const richDay = {
      id: 'day_1',
      schedule: [1, 2, 3, 4].map((i) => ({
        anchor: `Anchor ${i}`,
        contingency: { alternatives: [{ name: `Backup ${i}`, reason: 'rain' }] },
      })),
    };
    await writeFile(join(out, 'data', 'days.json'), JSON.stringify([
      richDay, { ...richDay, id: 'day_1' }, { ...richDay, id: '   ' },
    ]));
    const result = await auditContentDepth(out);
    expect(result.ok).toBe(false);
    expect(result.metrics.anchorsPerDay).toBeCloseTo(12 / 7);
    expect(result.issues.join('\n')).toMatch(/trip dates span 7/);
    expect(result.issues.join('\n')).toMatch(/day id must be non-blank/);
    expect(result.issues.join('\n')).toMatch(/day ids must be unique/);

    await writeFile(join(out, 'data', 'trip.json'), JSON.stringify({
      dates: { start: '2026-02-30', end: '2026-02-20' },
      travelers: [{ role: 'parent', age_band: 'adult' }],
    }));
    const invalidDates = await auditContentDepth(out);
    expect(invalidDates.issues.join('\n')).toMatch(/real ISO dates/);
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
});

test('family profile rejects renderer-incompatible top-level data shapes', async () => {
  const out = await makeTrip();
  try {
    const days = JSON.parse(await readFile(join(out, 'data', 'days.json'), 'utf8'));
    await writeFile(join(out, 'data', 'days.json'), JSON.stringify({ days }));
    const wrappedDays = await auditContentDepth(out);
    expect(wrappedDays.ok).toBe(false);
    expect(wrappedDays.issues.join('\n')).toMatch(/days\.json must be a top-level JSON array/);

    await writeFile(join(out, 'data', 'days.json'), JSON.stringify(days));
    await writeFile(join(out, 'data', 'desserts.json'), JSON.stringify({ items: [] }));
    const wrappedCorpus = await auditContentDepth(out);
    expect(wrappedCorpus.ok).toBe(false);
    expect(wrappedCorpus.issues.join('\n')).toMatch(/desserts\.json must be a top-level JSON array/);
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
});

test('family profile rejects missing/duplicate venue ids and does not inflate density with duplicates', async () => {
  const out = await makeTrip();
  try {
    await writeFile(join(out, 'data', 'desserts.json'), JSON.stringify([{
      id: 'venue-0', day_keys: ['day_1'], name_zh: '重複店', why_picked: 'same id', maps_query: 'Duplicate', hours: '09:00-18:00',
    }]));
    const duplicate = await auditContentDepth(out);
    expect(duplicate.ok).toBe(false);
    expect(duplicate.metrics.venues).toBe(6);
    expect(duplicate.issues.join('\n')).toMatch(/venue ids must be unique across corpora/);

    const food = JSON.parse(await readFile(join(out, 'data', 'food.json'), 'utf8'));
    food[0].id = '   ';
    await writeFile(join(out, 'data', 'food.json'), JSON.stringify(food));
    await writeFile(join(out, 'data', 'desserts.json'), '[]');
    const missing = await auditContentDepth(out);
    expect(missing.ok).toBe(false);
    expect(missing.metrics.venues).toBe(5);
    expect(missing.issues.join('\n')).toMatch(/food:Fallback Venue\(id\)/);
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
});

test('family profile requires every counted venue to be assigned to real trip days', async () => {
  const out = await makeTrip();
  try {
    const food = JSON.parse(await readFile(join(out, 'data', 'food.json'), 'utf8'));
    for (const [i, entry] of food.entries()) {
      entry.day_keys = i === 0 ? []
        : i === 1 ? ['day_1', '   ']
        : i === 2 ? ['day_1', 99]
        : i === 3 ? ['day_1', null]
        : ['day_99'];
    }
    await writeFile(join(out, 'data', 'food.json'), JSON.stringify(food));
    const result = await auditContentDepth(out);
    expect(result.ok).toBe(false);
    expect(result.metrics.venues).toBe(0);
    expect(result.metrics.venuesPerDay).toBe(0);
    expect(result.issues.join('\n')).toMatch(/day_keys/);
    expect(result.issues.join('\n')).toMatch(/confirmed-venue density/);
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
});

test('dup-ref rejects exact and normalized schedule duplicates but exempts contingency prep_refs', async () => {
  const out = await makeTrip();
  try {
    await writeFile(join(out, 'data', 'refs.json'), JSON.stringify({ schedule_refs: {
      day_1: [
        { title: 'Exact A', url: 'https://example.com/same' },
        { title: 'Exact B', url: 'https://example.com/same' },
      ],
    } }));
    expect((await auditDupRefs(out)).ok).toBe(false);

    await writeFile(join(out, 'data', 'refs.json'), JSON.stringify({ schedule_refs: {
      day_1: [{ title: 'YouTube A', url: 'https://youtu.be/abcdefghijk?utm_source=x' }],
      day_2: [{ title: 'YouTube B', url: 'https://www.youtube.com/watch?v=abcdefghijk&feature=share' }],
    } }));
    expect((await auditDupRefs(out)).ok).toBe(false);

    await writeFile(join(out, 'data', 'refs.json'), JSON.stringify({ schedule_refs: {
      day_1: [{ title: 'Schedule', url: 'https://example.com/reusable' }],
    } }));
    await writeFile(join(out, 'data', 'days.json'), JSON.stringify([{
      id: 'day_1',
      schedule: [{ anchor: 'A', contingency: { prep_refs: [{ url: 'https://example.com/reusable' }] } }],
    }]));
    expect((await auditDupRefs(out)).ok).toBe(true);
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
});

test('family profile independently rejects reversed valid dates', async () => {
  const out = await makeTrip();
  try {
    const trip = JSON.parse(await readFile(join(out, 'data', 'trip.json'), 'utf8'));
    trip.dates = { start: '2026-07-21', end: '2026-07-20' };
    await writeFile(join(out, 'data', 'trip.json'), JSON.stringify(trip));
    expect((await auditContentDepth(out)).issues.join('\n')).toMatch(/on\/after dates\.start/);
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
});

test('family profile independently rejects unique day ids in the wrong order', async () => {
  const out = await makeTrip();
  try {
    const days = JSON.parse(await readFile(join(out, 'data', 'days.json'), 'utf8'));
    days.reverse();
    await writeFile(join(out, 'data', 'days.json'), JSON.stringify(days));
    expect((await auditContentDepth(out)).issues.join('\n')).toMatch(/day_1\.\.day_N/);
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
});

test('family profile independently rejects missing or out-of-sequence day dates', async () => {
  const out = await makeTrip();
  try {
    const days = JSON.parse(await readFile(join(out, 'data', 'days.json'), 'utf8'));
    days[0].date = '';
    days[1].date = '2026-07-20';
    await writeFile(join(out, 'data', 'days.json'), JSON.stringify(days));
    const issues = (await auditContentDepth(out)).issues.join('\n');
    expect(issues).toMatch(/dates must match the trip span in order/);
    expect(issues).toMatch(/index 1=\(missing\)/);
    expect(issues).toMatch(/index 2=2026-07-20 \(expected 2026-07-21\)/);
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
});

test('family profile independently rejects an empty travelers list', async () => {
  const out = await makeTrip();
  try {
    const trip = JSON.parse(await readFile(join(out, 'data', 'trip.json'), 'utf8'));
    trip.travelers = [];
    await writeFile(join(out, 'data', 'trip.json'), JSON.stringify(trip));
    expect((await auditContentDepth(out)).issues.join('\n')).toMatch(/travelers is empty/);
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
});

test('trusted browser suite fails closed when runner is missing or exits nonzero', async () => {
  const missing = await runBrowserSuite('/tmp/untrusted-trip', {
    runnerInstalled: () => false,
  });
  expect(missing).toEqual({ ran: false, ok: false });

  let invocation: any = null;
  let closed = false;
  const failed = await runBrowserSuite('relative-untrusted-trip', {
    runnerInstalled: () => true,
    startServer: async (out) => {
      expect(out).toBe(resolve('relative-untrusted-trip'));
      return {
        origin: 'http://trip-pwa.test:43210', directOrigin: 'http://127.0.0.1:43210',
        close: async () => { closed = true; },
      };
    },
    runProcess: async (command: string, args: string[], options: any) => {
      invocation = { command, args, options };
      return 7;
    },
  });
  expect(failed).toEqual({ ran: true, ok: false });
  expect(closed).toBe(true);
  expect(invocation.command).toBe('bun');
  expect(invocation.args.join(' ')).toContain('launch-check.playwright.config.ts');
  expect(invocation.args.join(' ')).not.toContain('relative-untrusted-trip');
  expect(invocation.options.cwd).not.toBe('relative-untrusted-trip');
  expect(invocation.options.env.TRIP_PWA_BASE_URL).toBe('http://trip-pwa.test:43210');
  expect(invocation.options.env.TRIP_PWA_DENY_PROXY).toBe('http://127.0.0.1:43210');
});

test('trusted static server owns its port, locks network policy, and rejects served-tree symlinks', async () => {
  const out = await makeTrip();
  const parent = join(out, '..');
  const victim = join(parent, 'victim.txt');
  const linkedRoot = join(parent, 'linked-trip');
  try {
    await writeFile(join(out, 'index.html'), '<!doctype html><title>trusted</title>');
    await writeFile(join(out, 'secret.txt'), 'must not be served');
    const server = await startTrustedStaticServer(out);
    try {
      const index = await fetch(`${server.directOrigin}/index.html`);
      expect(index.status).toBe(200);
      expect(index.headers.get('content-security-policy')).toContain("connect-src 'self'");
      expect(index.headers.get('content-security-policy')).toContain("worker-src 'none'");
      expect((await fetch(`${server.directOrigin}/secret.txt`)).status).toBe(404);
      expect((await fetch(`${server.directOrigin}/data/../secret.txt`)).status).toBe(404);
      const blocked = await fetch('http://example.invalid/exfil', {
        // Exercise the listener's absolute-form proxy boundary directly.
        // @ts-ignore Bun supports an explicit proxy for fetch in this test.
        proxy: server.directOrigin,
      });
      expect(blocked.status).toBe(403);
    } finally { await server.close(); }

    await writeFile(victim, 'outside');
    await symlink(victim, join(out, 'data', 'leak.txt'));
    await expect(startTrustedStaticServer(out)).rejects.toThrow(/refuses symlinked content/);
    await rm(join(out, 'data', 'leak.txt'));

    await symlink(out, linkedRoot);
    await expect(startTrustedStaticServer(linkedRoot)).rejects.toThrow(/real trip directory/);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('--no-browser-tests is the explicit partial escape hatch; --no-a11y is deprecated', async () => {
  const out = await makeTrip();
  try {
    const partial = spawnSync('bun', [launchCheck, '--out', out, '--no-browser-tests'], { encoding: 'utf8' });
    expect(partial.status).toBe(0);
    expect(partial.stdout).toContain('content-depth'); // family quality is the default
    expect(partial.stdout).toContain('browser suite (--no-browser-tests)');
    expect(partial.stdout).toContain('partial check only');

    const deprecated = spawnSync('bun', [launchCheck, '--out', out, '--no-a11y'], { encoding: 'utf8' });
    expect(deprecated.status).toBe(0);
    expect(deprecated.stderr).toContain('DEPRECATED');
    expect(deprecated.stdout).toContain('deprecated alias');

    const noQuality = spawnSync('bun', [launchCheck, '--out', out, '--no-browser-tests', '--no-quality'], { encoding: 'utf8' });
    expect(noQuality.status).toBe(0);
    expect(noQuality.stdout).toContain('content quality (--no-quality)');

    const qualified = spawnSync('bun', [launchCheck, '--out', out, '--quality', 'family', '--no-browser-tests'], { encoding: 'utf8' });
    expect(qualified.status).toBe(0);
    expect(qualified.stdout).toContain('content-depth');

    const unknown = spawnSync('bun', [launchCheck, '--out', out, '--quality', 'bogus', '--no-browser-tests'], { encoding: 'utf8' });
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('Unknown --quality profile');

    const conflicting = spawnSync('bun', [launchCheck, '--out', out, '--quality', 'family', '--no-quality'], { encoding: 'utf8' });
    expect(conflicting.status).toBe(2);
    expect(conflicting.stderr).toContain('--quality cannot be combined with --no-quality');
  } finally { await rm(join(out, '..'), { recursive: true, force: true }); }
});
