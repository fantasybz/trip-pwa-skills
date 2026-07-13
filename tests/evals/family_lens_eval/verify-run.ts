// verify-run.ts — run the SHIPPED verifier (ai-verify.callVerify) over a set of
// baseline drafts to (re)produce the `vfy-out` jsonl that verify-pass.ts scores.
//
// The committed harness could SCORE a verify pass (verify-pass.ts) but never
// GENERATE one — v0.9.0 produced the vfy-out chunks out-of-band, so the verify
// numbers in RESULTS.md were not reproducible from the repo. This closes that gap
// and adds the precision levers: `--mode strict` runs the verifier with the
// conservative clause (ai-verify VERIFY_STRICT_CLAUSE); `--mode confidence` runs
// the scored-claims variant (VERIFY_CONFIDENCE_CLAUSE + {claim, confidence}
// items) whose output verify-pass.ts can threshold-sweep post-hoc. Needs
// ANTHROPIC_API_KEY + fetch. Prefer `bun precision-ab.ts` — it drives all three
// modes + scoring in one command.
//
//   # 1. produce baseline drafts (run.ts file/anthropic mode) → drafts.baseline.jsonl
//   # 2. verify them under each mode:
//   ANTHROPIC_API_KEY=sk-ant-... bun verify-run.ts --drafts drafts.baseline.jsonl --mode default --out vfy-out.default.jsonl
//   ANTHROPIC_API_KEY=sk-ant-... bun verify-run.ts --drafts drafts.baseline.jsonl --mode strict  --out vfy-out.strict.jsonl
//   ANTHROPIC_API_KEY=sk-ant-... bun verify-run.ts --drafts drafts.baseline.jsonl --mode confidence --out vfy-out.confidence.jsonl
//   # 3. score each against the Codex ground truth:
//   bun verify-pass.ts --vfy vfy-out.default.jsonl --label default
//   bun verify-pass.ts --vfy vfy-out.strict.jsonl  --label strict
//   bun verify-pass.ts --vfy vfy-out.confidence.jsonl --label confidence   # + τ-sweep table
//
// Writes one {id, unsupported_claims, verdict} object per line — the exact shape
// verify-pass.ts feeds through parseVerifyResult. Confidence-mode rows add
// `claims: [{claim, confidence}]` (unsupported_claims stays plain strings, so
// any binary consumer reads the row unchanged).

import { writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVenues, type Venue } from './assemble.ts';
import { parseArg } from './eval-lib.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const a = (f: string, d?: string) => parseArg(process.argv, f, d);

const inPath = resolve(HERE, a('--in', 'venues.jsonl')!);
const draftsPath = resolve(HERE, a('--drafts', 'drafts.baseline.jsonl')!);
const mode = a('--mode', 'default')!;            // 'default' | 'strict' | 'confidence'
const strict = mode === 'strict';
const confidence = mode === 'confidence';
const limit = a('--limit') ? Number(a('--limit')) : Infinity;
const outPath = resolve(HERE, a('--out', `vfy-out.${mode}.jsonl`)!);

const key = process.env.ANTHROPIC_API_KEY;
if (!key) { console.error('ANTHROPIC_API_KEY required'); process.exit(2); }
if (mode !== 'default' && mode !== 'strict' && mode !== 'confidence') { console.error(`--mode must be default|strict|confidence (got ${mode})`); process.exit(2); }

// browser ES modules expect a sessionStorage; ai.setKey stores in-memory anyway.
(globalThis as any).sessionStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
const ai = await import('../../../templates/js/ai.js');
const { callVerify } = await import('../../../templates/js/ai-verify.js');
ai.setKey(key);

type Draft = { id: string; why_picked: string; kid_friendly?: boolean };
const drafts: Draft[] = readFileSync(draftsPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const byId = new Map(drafts.map((d) => [String(d.id), d]));
if (byId.size !== drafts.length) {
  // Duplicate ids would silently last-write-wins into the map — a corrupt or
  // concatenated drafts file must not quietly verify half its rows.
  console.error(`verify-run: ${drafts.length - byId.size} duplicate draft id(s) in ${draftsPath} — fix the drafts file.`);
  process.exit(2);
}
const matched: Venue[] = loadVenues(inPath).filter((v) => byId.has(String(v.id)));
if (matched.length < byId.size) console.error(`[verify-run] ⚠️ ${byId.size - matched.length} draft id(s) match no venue row (stale/renamed ids?)`);
const venues: Venue[] = matched.slice(0, limit);

console.error(`[verify-run] mode=${mode} verifying ${venues.length} drafts → ${outPath}`);
writeFileSync(outPath, '');   // fresh file; append per row so a crash keeps partial progress

let flagged = 0;
const failed: string[] = [];
for (const v of venues) {
  const draft = byId.get(String(v.id))!;
  const r = await callVerify(v, { why_picked: draft.why_picked, kid_friendly: draft.kid_friendly }, { strict, confidence });
  if (!r.ok) { console.error(`  verify fail ${v.id}: ${r.error}`); failed.push(String(v.id)); continue; }
  if (r.verdict === 'has_unsupported') flagged++;
  const row: Record<string, unknown> = { id: v.id, unsupported_claims: r.unsupported, verdict: r.verdict };
  if (confidence) row.claims = (r as any).claims;   // scored variant rides along; binary consumers ignore it
  appendFileSync(outPath, JSON.stringify(row) + '\n');
}

console.error(`[verify-run] done — flagged ${flagged}/${venues.length - failed.length} (${mode}) → ${outPath}`);
if (failed.length) {
  // A partial arm is a BIASED arm: scoring it against the full ground truth
  // skews every rate, and an A/B on non-identical row sets is meaningless.
  // Keep the partial file (rows already written are still useful for manual
  // inspection) but exit non-zero so orchestrators (precision-ab.ts) abort
  // instead of scoring a subset — Codex xhigh flagged the old exit-0 path as
  // a false-green vector.
  console.error(`[verify-run] ❌ ${failed.length}/${venues.length} verify failures (no row written): ${failed.join(', ')}`);
  console.error('[verify-run] partial output kept, exiting 3 — rerun (or accept the gap consciously by scoring by hand).');
  process.exit(3);
}
