// regenerate-sw.ts — shared service-worker manifest generator.
//
// Scans a scaffolded trip dir, classifies every shipped file into
// REQUIRED_SHELL / REQUIRED_CONTENT / OPTIONAL_ASSETS, content-hashes them, and
// (re)writes <tripDir>/sw.js from templates/sw.js.template. Called by EVERY
// write-path skill (trip-scaffold init/draft-days, food-ingest, refs-ingest)
// after its batch of writes, so the offline cache stays in sync (design doc D2).
//
// Hard-errors on a shipped file that matches no bucket (Codex P3 — weekend-2
// guard for new asset families like lib/ or fonts). SW_VERSION = trip start date
// + short hash of file CONTENTS, so editing a file busts the cache even when the
// filename is unchanged (Codex P2).

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SwManifest {
  version: string;
  shell: string[];
  content: string[];
  optional: string[];
}

async function sha1Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function regenerateServiceWorker(tripDir: string): Promise<SwManifest> {
  const template = fileURLToPath(new URL('../../templates/sw.js.template', import.meta.url));
  const tpl = await readFile(template, 'utf8');

  const shell: string[] = [];
  const content: string[] = [];
  const optional: string[] = [];
  const unclassified: string[] = [];

  // Dev / non-runtime dirs that exist in the trip dir but must NOT be cached by
  // the service worker (and must NOT trip the unclassified hard-error). Dot-dirs
  // (.git/.github/.gstack/.vscode/…) are handled by the dot-skip in walk(), so
  // they don't need listing here.
  const SKIP_DIRS = new Set([
    'tests', 'node_modules',
    'test-results', 'playwright-report',   // Playwright artifacts (post-launch-check)
  ]);
  // Any markdown anywhere, plus specific dev/config files (Codex P3: the *.md
  // skip is general, not just a few top-level names). Dotfiles (.DS_Store,
  // .gitignore, …) are caught by the dot-skip in walk().
  const isSkipFile = (path: string) =>
    /\.md$/i.test(path) ||
    /^\.\/(playwright\.config\.ts|package\.json|bun\.lockb?|tsconfig\.json)$/.test(path);

  async function walk(rel: string) {
    const entries = await readdir(join(tripDir, rel), { withFileTypes: true });
    for (const e of entries) {
      // Skip any dot-entry (file or dir) at any depth: .git, .github, .DS_Store,
      // and stray agent/editor metadata like .gstack that a tool wrote into the
      // trip dir. None are shippable; without this they hit the unclassified
      // hard-error and break the next ingest (A2 dogfood, codex P2-c).
      if (e.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!rel && SKIP_DIRS.has(e.name)) continue;   // skip top-level dev dirs
        await walk(childRel);
        continue;
      }
      if (childRel === 'sw.js') continue;          // the file being generated
      const path = './' + childRel;
      if (isSkipFile(path)) continue;              // dev/non-runtime file
      if (/^\.\/(index\.html|day\.html|manifest\.json)$/.test(path)
        || /^\.\/css\/[^/]+\.css$/.test(path)
        || /^\.\/js\/[^/]+\.js$/.test(path)) {
        shell.push(path);
      } else if (/^\.\/data\/[^/]+\.json$/.test(path)) {
        content.push(path);
      } else if (/^\.\/assets\/(icons|photos)\//.test(path)) {
        optional.push(path);
      } else {
        unclassified.push(path);
      }
    }
  }
  await walk('');

  if (unclassified.length) {
    throw new Error(
      'regenerate-sw: unclassified shipped files (extend the classifier):\n  ' +
      unclassified.join('\n  ')
    );
  }

  shell.push('./');                 // navigation root
  shell.sort(); content.sort(); optional.sort();

  // date seed from trip.json (stable, no Date.now); fall back to 'undated'
  let dateSeed = 'undated';
  try {
    const trip = JSON.parse(await readFile(join(tripDir, 'data', 'trip.json'), 'utf8'));
    if (trip?.dates?.start) dateSeed = String(trip.dates.start);
  } catch (_) { /* keep fallback */ }

  // content hash of every cacheable file — shell + content + optional (Codex P2:
  // an icon/photo edit at the same path must still bust the cache).
  const cacheable = [...shell.filter((p) => p !== './'), ...content, ...optional];
  const digests: string[] = [];
  for (const p of cacheable) {
    const buf = await readFile(join(tripDir, p.replace(/^\.\//, '')));
    digests.push(p + ':' + await sha1Hex(buf));
  }
  const hash = (await sha1Hex(new TextEncoder().encode(digests.join('|')))).slice(0, 7);
  const version = `${dateSeed}-${hash}`;

  const fmt = (arr: string[]) => arr.map((p) => `  '${p}',`).join('\n');
  const sw = tpl
    .split('%SW_VERSION%').join(version)
    .split('  // %REQUIRED_SHELL_MANIFEST%').join(fmt(shell))
    .split('  // %REQUIRED_CONTENT_MANIFEST%').join(fmt(content))
    .split('  // %OPTIONAL_CONTENT_MANIFEST%').join(fmt(optional))
    .split('{{TRIP_TITLE}}').join('trip');
  await writeFile(join(tripDir, 'sw.js'), sw);

  return { version, shell, content, optional };
}
