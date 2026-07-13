// verify-pass.ts — v3 measurement: does the verify-pass clear the eval gate?
//
// Joins each BASELINE draft's verify result (sonnet self-verify, via
// buildVerifyUser) with the Codex judge's ground-truth severity (report.baseline.
// json). A draft the verifier flags `has_unsupported` would be HELD/warned before
// it ships. We measure the major-hallucination rate among the drafts the verifier
// LETS THROUGH (verdict 'clean') — that is the post-verify gate metric — plus the
// verifier's recall on real majors and its flag rate (UX cost). The scoring math
// lives in eval-lib (scoreVerify) so this report, the τ-sweep below, and
// precision-ab.ts can never disagree.
//
//   bun verify-pass.ts                                  # historical 5-chunk read
//   bun verify-pass.ts --vfy vfy-out.strict.jsonl --label strict   # one verify-run.ts output
//
// --vfy <path>   : a single vfy-out jsonl (verify-run.ts output) instead of the
//                  historical 5-chunk .context/dogfood/gen read.
// --label <name> : header label (for the precision A/B arms).
// --truth <path> : Codex ground-truth report (default report.baseline.json).
// --sweep <list> : comma τ list for confidence-mode rows (default
//                  0.5,0.6,0.7,0.75,0.8,0.85,0.9). Only printed when the vfy
//                  file carries scored claims (verify-run.ts --mode confidence).
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVerifyResult } from '../../../templates/js/ai-verify.js';
import {
  parseArg, readJsonl as jl,
  scoreVerify, sweepVerify, pickOperatingPoint, normalizeScoredClaims, type VerifyRow,
} from './eval-lib.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const GEN = resolve(HERE, '../../../../.context/dogfood/gen');
const a = (f: string, d?: string) => parseArg(process.argv, f, d);
const vfyArg = a('--vfy');
const label = a('--label', vfyArg ? '' : 'baseline')!;

// Codex ground truth (per-venue severity + validatorOk) from the baseline run.
const base = JSON.parse(readFileSync(resolve(HERE, a('--truth', 'report.baseline.json')!), 'utf8'));
const truth = new Map<string, any>(base.rows.map((r: any) => [String(r.id), r]));

// Verify results, normalized through the shipped parseVerifyResult. Either one
// --vfy file (verify-run.ts) or the historical 5-chunk .context/dogfood/gen read.
// Confidence-mode rows (verify-run.ts --mode confidence) additionally carry
// `claims: [{claim, confidence}]` — kept on the row for the τ-sweep; the binary
// fields are unchanged so this block scores them exactly like any other row.
const verify = new Map<string, VerifyRow>();
const sources = vfyArg ? [resolve(HERE, vfyArg)] : Array.from({ length: 5 }, (_, k) => `${GEN}/vfy-out-${k}.jsonl`);
for (const src of sources) {
  let rows: any[];
  try { rows = jl(src); }
  catch (e) {
    // An explicit --vfy file that can't be read is a HARD error: silently
    // skipping it leaves N=0 and pct(0,0)=0 → a false-green GATE PASS. The
    // historical 5-chunk read stays best-effort (a missing chunk is normal).
    if (vfyArg) { console.error(`verify-pass: cannot read --vfy ${src}: ${(e as Error).message}`); process.exit(2); }
    continue;
  }
  for (const r of rows) {
    const p = parseVerifyResult(r);
    if (!p.ok) continue;
    const row: VerifyRow = { id: String(r.id), verdict: p.verdict, unsupported: p.unsupported };
    const claims = normalizeScoredClaims(r.claims);
    if (claims) row.claims = claims;
    verify.set(String(r.id), row);
  }
}

const rows = [...verify.values()];
const s = scoreVerify(rows, truth);
if (s.n === 0) {
  // No verify result joined the ground truth → there is nothing to score. Don't
  // let pct(0,0)=0 print a misleading GATE PASS; fail loudly instead.
  console.error('verify-pass: 0 joined rows (no verify result matched the ground-truth ids) — nothing to score, NOT a pass.');
  process.exit(2);
}

console.log(`\n══ v3 verify-pass${label ? ` [${label}]` : ''} on the BASELINE drafts (sonnet self-verify), n=${s.n} ══`);
console.log(`coverage: ${s.n}/${base.rows.length} baseline drafts had a verify result`);
console.log(`verifier flag rate (has_unsupported): ${s.flagRatePct}%  (${s.flaggedN}/${s.n})  ← drafts warned/held`);
console.log('');
console.log(`MAJOR-hallucination-rate:`);
console.log(`  before verify (all drafts):        ${s.beforeMajorPct}%   (${s.beforeMajorN}/${s.n})`);
console.log(`  AFTER verify (drafts let through):  ${s.letThroughMajorPct}%   (${s.letThroughMajorN}/${s.cleanN})   ← GATE metric (≤10%)`);
console.log('');
console.log(`verifier recall on real majors:  ${s.recallPct}%  (caught ${s.recallCaughtN}/${s.beforeMajorN})`);
console.log(`verifier precision (flagged that actually hallucinate): ${s.precisionPct}%  (${s.precisionHallN}/${s.flaggedN})`);
console.log(`\nGATE after verify-pass: ${
  s.cleanN === 0 ? 'UNDETERMINED ⚠️ (0 drafts let through — no let-through evidence, not a pass)'
  : s.gatePass ? 'PASS ✅ (≤10%)' : 'FAIL ❌ (>10%)'
}`);

// ---- τ-sweep (confidence-mode rows only) --------------------------------------
// One scored run yields the whole precision/recall curve: flag iff any claim's
// confidence ≥ τ, re-scored per τ entirely in JS. The recommended operating
// point applies the experiment's decision rule (gate ≤10% AND recall ≥80%,
// fewest flags wins) — see docs/verify-precision-experiment.md.
const scoredN = rows.filter((r) => Array.isArray(r.claims)).length;
if (scoredN > 0) {
  const taus = (a('--sweep', '0.5,0.6,0.7,0.75,0.8,0.85,0.9')!)
    .split(',').map(Number).filter((t) => Number.isFinite(t) && t >= 0 && t <= 1);
  const sweep = sweepVerify(rows, truth, taus);
  console.log(`\n── confidence τ-sweep (${scoredN}/${rows.length} rows scored; flag iff any claim ≥ τ) ──`);
  console.log('    τ    flag%   let-through major%   recall%   precision%   gate');
  for (const x of sweep) {
    console.log(
      `  ${x.tau!.toFixed(2).padEnd(5)}` +
      `${String(x.flagRatePct).padStart(6)}` +
      `${String(x.letThroughMajorPct).padStart(12)} (${x.letThroughMajorN}/${x.cleanN})`.padEnd(22) +
      `${String(x.recallPct).padStart(6)}` +
      `${String(x.precisionPct).padStart(10)}` +
      `      ${x.gatePass ? 'PASS' : 'fail'}`,
    );
  }
  const best = pickOperatingPoint(sweep);
  console.log(best
    ? `\n★ recommended τ = ${best.tau} — flag ${best.flagRatePct}% / let-through ${best.letThroughMajorPct}% / recall ${best.recallPct}% / precision ${best.precisionPct}%`
    : '\n★ no τ meets gate ≤10% + recall ≥80% — keep the shipped default verifier');
}
