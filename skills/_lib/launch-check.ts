#!/usr/bin/env bun
// launch-check.ts — pre-publish audit for a generated trip PWA (eng-review D10).
// Two audits:
//   1. dup-ref (static, always runs): schedule_refs URLs must be unique across
//      the trip. Inline contingency prep_refs are EXEMPT (they may reuse a
//      schedule_refs URL — mirrors Tokyo's R11′ rule).
//   2. a11y-behavior (Playwright, if installed): focus-visible, tablist arrow
//      nav, synthetic-click. Runs templates/tests/a11y.spec.ts against the
//      served PWA. Skipped with a notice if @playwright/test isn't resolvable.
//
// Exit 0 = all audits passed; exit 1 = a failure (dup-ref or a11y).
//
// Usage:  bun launch-check.ts --out ./trip [--no-a11y]

import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { urlKey } from './url-key';

interface Args { [k: string]: string }
function parseArgs(argv: string[]): Args {
  const a: Args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { a[key] = next; i++; }
    else a[key] = 'true';
  }
  return a;
}

async function readJson(path: string): Promise<any | null> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e: any) { if (e?.code === 'ENOENT') return null; throw e; }
}

// AUDIT 1 — dup-ref. Returns list of duplicate schedule_refs URLs (empty = pass).
async function auditDupRefs(out: string): Promise<{ ok: boolean; dups: string[] }> {
  const refs = await readJson(join(out, 'data', 'refs.json'));
  const seen = new Set<string>();
  const dups = new Set<string>();
  const sched = refs?.schedule_refs;
  if (sched && typeof sched === 'object') {
    for (const arr of Object.values(sched)) {
      if (!Array.isArray(arr)) continue;
      for (const e of arr as any[]) {
        const u = e?.url;
        if (!u) continue;
        const k = urlKey(u);   // normalized — catches tracking-param / yt-variant dups (Codex P2)
        if (seen.has(k)) dups.add(u); else seen.add(k);
      }
    }
  }
  // Inline prep_refs on days.json contingencies are EXEMPT — not counted, not
  // checked against schedule_refs (R11′). We read them only to be explicit that
  // they are intentionally skipped.
  return { ok: dups.size === 0, dups: [...dups] };
}

// AUDIT 2 — a11y behavior via Playwright, if the @playwright/test RUNNER is
// installed in the trip dir (Codex P1: probing `bunx playwright` resolved the
// wrong 'playwright' package — which has no `test` command — and generated PWAs
// have no node_modules). Check for the runner package directly.
function playwrightRunnerInstalled(out: string): boolean {
  return existsSync(join(out, 'node_modules', '@playwright', 'test', 'package.json'));
}

function runA11y(out: string): { ran: boolean; ok: boolean } {
  if (!playwrightRunnerInstalled(out)) return { ran: false, ok: true };
  // run the local runner so cwd=out resolves @playwright/test from out/node_modules
  const res = spawnSync('bunx', ['playwright', 'test', '--config', 'playwright.config.ts'], {
    cwd: out, stdio: 'inherit',
  });
  return { ran: true, ok: res.status === 0 };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const out = a.out;
  if (!out) { console.error('Required: --out <trip dir>'); process.exit(2); }
  try { if (!(await stat(out)).isDirectory()) throw new Error(); }
  catch { console.error(`--out ${out} is not a directory`); process.exit(1); }

  let failed = false;

  // Audit 1
  const dup = await auditDupRefs(out);
  if (dup.ok) {
    console.log('✓ dup-ref: schedule_refs URLs are unique');
  } else {
    failed = true;
    console.error('✗ dup-ref: duplicate schedule_refs URLs:');
    for (const u of dup.dups) console.error('    ' + u);
    console.error('  (inline contingency prep_refs are exempt; fix duplicate schedule_refs)');
  }

  // Audit 2
  let a11ySkipped = false;
  if (a['no-a11y'] === 'true') {
    a11ySkipped = true;
    console.log('• a11y-behavior: skipped (--no-a11y)');
  } else {
    const a11y = runA11y(out);
    if (!a11y.ran) {
      a11ySkipped = true;
      console.log('• a11y-behavior: skipped (@playwright/test not installed in the trip dir — run');
      console.log(`    cd ${out} && bun install && bunx playwright install chromium)`);
    } else if (a11y.ok) {
      console.log('✓ a11y-behavior: focus-visible + tablist arrow + synthetic-click pass');
    } else {
      failed = true;
      console.error('✗ a11y-behavior: Playwright suite failed (see output above)');
    }
  }

  if (failed) { console.error('\nlaunch-check FAILED'); process.exit(1); }
  // Don't print a flat green when a11y didn't actually run — that read as "a11y
  // passed" to dogfood users (C2/X1). Qualify it instead.
  if (a11ySkipped) {
    console.log('\n✓ dup-ref passed — a11y SKIPPED (not run; install @playwright/test in the trip to verify it before publishing)');
  } else {
    console.log('\n✓ launch-check passed');
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
