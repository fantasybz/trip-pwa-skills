// precision-ab.ts — the ONE-COMMAND verifier-precision A/B.
//
// Runs the shipped verifier over the SAME baseline drafts under each arm
// (default / strict / confidence), scores every arm against the same Codex
// ground truth with the shared eval-lib math, τ-sweeps the confidence arm, and
// applies the decision rule from docs/verify-precision-experiment.md. Writes
// precision-ab.results.md (paste-ready for the experiment doc) and prints the
// same to stdout. One generation, one truth set → the deltas are pure prompt/
// threshold effect, no judge variance.
//
//   ANTHROPIC_API_KEY=sk-ant-... bun precision-ab.ts                # full 3-arm
//   ANTHROPIC_API_KEY=sk-ant-... bun precision-ab.ts --limit 40     # cheap smoke
//   bun precision-ab.ts --score-only                                # re-score existing vfy-out files, no key
//
// Flags: --provider <p>    (anthropic | openai; default anthropic. openai = the
//                           INFORMATIONAL OpenAI-BYOK-path variant: OPENAI_API_KEY,
//                           gpt-4o-mini self-verify, `.oai` default artifact names.
//                           The Codex judge shares that model family, so OpenAI-path
//                           results never authorize flipping the shipped default.)
//        --drafts <jsonl>  (default drafts.baseline[.oai].jsonl)
//        --truth <json>    (default report.baseline[.oai].json)
//        --modes <csv>     (default default,strict,confidence)
//        --limit <n>       (forwarded to verify-run.ts)
//        --reuse           (skip an arm whose vfy-out file already exists — resume)
//        --score-only      (never call the API; score whatever vfy-out files exist)
//        --sweep <csv>     (τ list, default 0.5,0.6,0.7,0.75,0.8,0.85,0.9)
//        --out <md>        (default precision-ab[.oai].results.md)
//
// Preconditions (once, from the existing harness — see the experiment doc):
//   ANTHROPIC_API_KEY=sk-ant-... bun run.ts --arm baseline --generate anthropic --judge codex
//   → drafts.baseline.jsonl + report.baseline.json
//
// Exit codes: 0 = report written (whatever the recommendation), 2 = preflight,
// child failure, or arm-consistency failure (never a silent false-green).
// Consistency guards (Codex xhigh P1 — stale/partial arms must not reach the
// recommendation block):
//   - every requested --modes arm file must exist (also under --score-only)
//   - unparseable rows in an arm file → hard fail (corrupt/stale file)
//   - all arms must join the IDENTICAL ground-truth id set (catches a --limit
//     smoke file reused into a full run, or a crashed partial arm)
//   - without --limit, that set must equal ALL draft ids that have ground truth
//   - verify-run.ts exits 3 on any per-row verify failure → aborts this script
//   - partial coverage (n < truth rows, i.e. --limit smoke) is allowed but the
//     report + recommendation carry an explicit not-decision-grade caveat

import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVerifyResult } from '../../../templates/js/ai-verify.js';
import {
  parseArg, fmtDelta, readJsonl,
  scoreVerify, sweepVerify, pickOperatingPoint, normalizeScoredClaims,
  type VerifyRow, type VerifyScore,
} from './eval-lib.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const a = (f: string, d?: string) => parseArg(process.argv, f, d);
const has = (f: string) => process.argv.includes(f);

const provider = a('--provider', 'anthropic')!;   // 'anthropic' | 'openai'
if (provider !== 'anthropic' && provider !== 'openai') { console.error(`precision-ab: --provider must be anthropic|openai (got ${provider})`); process.exit(2); }
const providerSuffix = provider === 'openai' ? '.oai' : '';

const draftsPath = resolve(HERE, a('--drafts', `drafts.baseline${providerSuffix}.jsonl`)!);
const truthPath = resolve(HERE, a('--truth', `report.baseline${providerSuffix}.json`)!);
const modes = a('--modes', 'default,strict,confidence')!.split(',').map((m) => m.trim()).filter(Boolean);
const limit = a('--limit');
const reuse = has('--reuse');
const scoreOnly = has('--score-only');
const sweepArg = a('--sweep', '0.5,0.6,0.7,0.75,0.8,0.85,0.9')!;
const outPath = resolve(HERE, a('--out', `precision-ab${providerSuffix}.results.md`)!);

const KNOWN = new Set(['default', 'strict', 'confidence']);
if (!modes.length) { console.error('precision-ab: --modes is empty'); process.exit(2); }
for (const m of modes) if (!KNOWN.has(m)) { console.error(`precision-ab: unknown mode "${m}" (default|strict|confidence)`); process.exit(2); }

// ---- preflight -----------------------------------------------------------------
const missing: string[] = [];
if (!existsSync(truthPath)) missing.push(truthPath);
if (!scoreOnly && !existsSync(draftsPath)) missing.push(draftsPath);
if (missing.length) {
  console.error(`precision-ab: missing prerequisite file(s):\n  ${missing.join('\n  ')}`);
  console.error(`\nProduce them once with the existing harness (needs ${provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'} + codex on PATH):`);
  console.error(`  ${provider === 'openai' ? 'OPENAI_API_KEY=sk-...' : 'ANTHROPIC_API_KEY=sk-ant-...'} bun run.ts --arm baseline --generate ${provider} --judge codex`);
  process.exit(2);
}
const keyVar = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
if (!scoreOnly && !process.env[keyVar]) {
  console.error(`precision-ab: ${keyVar} required (or use --score-only to re-score existing vfy-out files).`);
  process.exit(2);
}

const truthReport = JSON.parse(readFileSync(truthPath, 'utf8'));
// Metadata beats filenames (Codex xhigh P1): an .oai truth passed via an
// explicit --truth override must not be scored under the anthropic label — the
// caveat and artifact isolation would silently vanish. run.ts records the
// provider in the report (v0.10.6+: `provider`; older reports: infer from
// `generatedWith`; file-generated legacy reports carry neither → trust the CLI).
const truthProvider: string | null =
  truthReport.provider ?? (truthReport.generatedWith === 'openai' ? 'openai' : truthReport.generatedWith === 'anthropic' ? 'anthropic' : null);
if (truthProvider && truthProvider !== provider) {
  console.error(`precision-ab: truth ${truthPath} was generated on the "${truthProvider}" path but this run is --provider ${provider} — rerun with --provider ${truthProvider}.`);
  process.exit(2);
}
const truth = new Map<string, any>(truthReport.rows.map((r: any) => [String(r.id), r]));
// Draft ids are read whenever the file exists (even under --score-only): they
// define the EXPECTED joinable id set for the full-run consistency check.
const draftIds: string[] | null = existsSync(draftsPath) ? readJsonl<any>(draftsPath).map((d) => String(d.id)) : null;
if (!scoreOnly) {
  const perArm = limit ? Math.min(Number(limit), draftIds!.length) : draftIds!.length;
  console.error(`[precision-ab] arms: ${modes.join(', ')} — ~${perArm} verify calls per arm (${modes.length} arms) against ${draftsPath}`);
}

// ---- run each arm ----------------------------------------------------------------
const vfyPath = (m: string) => resolve(HERE, `vfy-out.${m}${providerSuffix}.jsonl`);
for (const m of modes) {
  const out = vfyPath(m);
  if (scoreOnly) continue;
  if (reuse && existsSync(out) && statSync(out).size > 0) { console.error(`[precision-ab] --reuse: keeping existing ${out}`); continue; }
  const args = ['bun', 'verify-run.ts', '--provider', provider, '--drafts', draftsPath, '--mode', m, '--out', out, ...(limit ? ['--limit', limit] : [])];
  console.error(`[precision-ab] ▶ ${args.join(' ')}`);
  const child = Bun.spawnSync(args, { cwd: HERE, stdout: 'inherit', stderr: 'inherit', env: process.env as Record<string, string> });
  if (child.exitCode !== 0) { console.error(`precision-ab: verify-run --mode ${m} failed (exit ${child.exitCode}) — aborting, nothing scored.`); process.exit(2); }
}

// ---- score every arm with the shared math ----------------------------------------
function loadRows(path: string): { rows: VerifyRow[]; dropped: number } {
  const byId = new Map<string, VerifyRow>();
  let dropped = 0;
  for (const r of readJsonl<any>(path)) {
    // Provider metadata on the row (verify-run v0.10.6+) must match this run —
    // an .oai vfy file reused/renamed into an anthropic-labeled run would emit
    // an uncaveated recommendation from the wrong path. Untagged legacy rows
    // are trusted to the CLI flag.
    if (typeof r.provider === 'string' && r.provider !== provider) {
      console.error(`precision-ab: ${path} rows are tagged provider:"${r.provider}" but this run is --provider ${provider} — rerun with --provider ${r.provider} (or delete the stale file).`);
      process.exit(2);
    }
    const p = parseVerifyResult(r);
    if (!p.ok) { dropped++; continue; }
    const row: VerifyRow = { id: String(r.id), verdict: p.verdict, unsupported: p.unsupported };
    const claims = normalizeScoredClaims(r.claims);
    if (claims) row.claims = claims;
    byId.set(String(r.id), row);
  }
  return { rows: [...byId.values()], dropped };
}

type Arm = { mode: string; score: VerifyScore; joinedIds: Set<string>; sweep?: VerifyScore[]; best?: VerifyScore | null };
const arms: Arm[] = [];
for (const m of modes) {
  const path = vfyPath(m);
  if (!existsSync(path)) {
    console.error(`precision-ab: required arm file missing: ${path}`);
    console.error(scoreOnly
      ? '  --score-only scores existing files, but EVERY requested --modes arm must exist — narrow --modes or run the missing arm first.'
      : '  the verify-run for this arm never produced output — aborting, nothing recommended.');
    process.exit(2);
  }
  const { rows, dropped } = loadRows(path);
  if (dropped > 0) { console.error(`precision-ab: ${dropped} unparseable row(s) in ${path} — corrupt or stale arm file; delete it and rerun.`); process.exit(2); }
  const score = scoreVerify(rows, truth);
  if (score.n === 0) { console.error(`precision-ab: arm "${m}" joined 0 ground-truth rows — nothing to score, NOT a pass.`); process.exit(2); }
  const arm: Arm = { mode: m, score, joinedIds: new Set(rows.filter((r) => truth.has(String(r.id))).map((r) => String(r.id))) };
  if (rows.some((r) => Array.isArray(r.claims))) {
    const taus = sweepArg.split(',').map(Number).filter((t) => Number.isFinite(t) && t >= 0 && t <= 1);
    arm.sweep = sweepVerify(rows, truth, taus);
    arm.best = pickOperatingPoint(arm.sweep);
  }
  arms.push(arm);
}

// ---- arm-consistency guards (no recommendation from non-comparable arms) ----------
const setDiffSample = (a: Set<string>, b: Set<string>) => [...a].filter((id) => !b.has(id)).slice(0, 5);
const ref = arms[0];
for (const x of arms.slice(1)) {
  if (x.joinedIds.size !== ref.joinedIds.size || [...x.joinedIds].some((id) => !ref.joinedIds.has(id))) {
    console.error(`precision-ab: arm id sets differ — ${ref.mode}=${ref.joinedIds.size} rows vs ${x.mode}=${x.joinedIds.size} rows.`);
    console.error(`  e.g. only in ${ref.mode}: ${setDiffSample(ref.joinedIds, x.joinedIds).join(', ') || '—'} | only in ${x.mode}: ${setDiffSample(x.joinedIds, ref.joinedIds).join(', ') || '—'}`);
    console.error('  A paired A/B needs IDENTICAL rows per arm (a stale --reuse smoke file or a crashed partial run breaks that).');
    console.error('  Fix: delete the stale vfy-out.*.jsonl and rerun without --reuse (or with the same --limit for every arm).');
    process.exit(2);
  }
}
// Without --limit, the arms must also cover EVERY draft that has ground truth —
// equal-but-truncated arms (e.g. all reused from the same smoke run) are not a
// full-run result and must not silently pose as one.
if (!limit && draftIds) {
  const expected = new Set(draftIds.filter((id) => truth.has(id)));
  if (expected.size !== ref.joinedIds.size || [...expected].some((id) => !ref.joinedIds.has(id))) {
    console.error(`precision-ab: arms cover ${ref.joinedIds.size}/${expected.size} expected draft×truth ids (e.g. missing: ${setDiffSample(expected, ref.joinedIds).join(', ') || '—'}).`);
    console.error('  Stale/partial vfy-out files — delete them and rerun, or pass --limit N explicitly for a smoke-scoped report.');
    process.exit(2);
  }
}
const truthN: number = truthReport.rows.length;
const partialCoverage = ref.joinedIds.size < truthN;

// ---- decision rule (docs/verify-precision-experiment.md) --------------------------
// 1. let-through major ≤ 10% (hard gate)   2. flag-rate materially lower (≤ ~45%)
// 3. recall ≥ ~80%. Candidates = strict arm + confidence@τ*; fewest flags wins.
const defaultArm = arms.find((x) => x.mode === 'default');
type Candidate = { name: string; s: VerifyScore };
const candidates: Candidate[] = [];
for (const x of arms) {
  if (x.mode === 'strict') candidates.push({ name: 'strict', s: x.score });
  if (x.mode === 'confidence' && x.best) candidates.push({ name: `confidence@τ=${x.best.tau}`, s: x.best });
}
const feasible = candidates.filter((c) => c.s.letThroughMajorPct <= 10 && c.s.recallPct >= 80);
feasible.sort((p, q) => p.s.flagRatePct - q.s.flagRatePct || q.s.precisionPct - p.s.precisionPct);
const winner = feasible[0];
let recommendation: string;
if (!winner) {
  recommendation = 'KEEP DEFAULT — no candidate passes gate ≤10% with recall ≥80%. The noise is the price of the gate.';
} else if (winner.s.flagRatePct <= 45) {
  recommendation = `FLIP to ${winner.name} — gate ${winner.s.letThroughMajorPct}% / recall ${winner.s.recallPct}% / flag-rate ${winner.s.flagRatePct}% (≤45% target met).` +
    (winner.name === 'strict'
      ? ' Flip = ai-enrich.js callVerify(…, { strict: true }).'
      : ' Flip = ai-enrich.js callVerify(…, { confidence: true }) + drop claims below τ before rendering the ⚠️ list.');
} else {
  recommendation = `${winner.name} passes gate+recall but flag-rate ${winner.s.flagRatePct}% misses the ≤45% target — not a material improvement; keep default or revisit τ.`;
}

// ---- report -----------------------------------------------------------------------
const cell = (v: number | string) => String(v);
const armCol = (name: string, s: VerifyScore | undefined, d: VerifyScore | undefined) => {
  if (!s) return { name, cells: ['—', '—', '—', '—'] };
  const delta = (dv: number | undefined, sv: number) => (d && dv !== undefined && s !== d ? ` (${fmtDelta(dv, sv)})` : '');
  return {
    name,
    cells: [
      `${s.flagRatePct}%${delta(d?.flagRatePct, s.flagRatePct)}`,
      `${s.precisionPct}%${delta(d?.precisionPct, s.precisionPct)}`,
      `${s.recallPct}%${delta(d?.recallPct, s.recallPct)}`,
      `${s.letThroughMajorPct}%${delta(d?.letThroughMajorPct, s.letThroughMajorPct)} ${s.gatePass ? '✅' : '❌'}`,
    ],
  };
};
const confArm = arms.find((x) => x.mode === 'confidence');
const cols = [
  armCol('default', defaultArm?.score, defaultArm?.score),
  armCol('strict', arms.find((x) => x.mode === 'strict')?.score, defaultArm?.score),
  armCol(confArm?.best ? `confidence@τ=${confArm.best.tau}` : 'confidence@τ*', confArm?.best ?? undefined, defaultArm?.score),
];
const metricNames = ['flag-rate (UX cost)', 'precision (flags that truly hallucinate)', 'recall on real majors', 'let-through major (GATE ≤10%)'];
const lines: string[] = [];
lines.push(`# verifier precision A/B — ${new Date().toISOString().slice(0, 10)}${provider === 'openai' ? ' — OpenAI path (informational)' : ''}`);
lines.push('');
if (provider === 'openai') {
  lines.push('> ⚠️ **OpenAI-path measurement (informational).** Generator + verifier are the OpenAI BYOK config (gpt-4o-mini self-verify via the harness fetch shim) while the ground-truth judge (Codex) shares the same model family — judge independence is weakened. These numbers characterize the OpenAI path; they do **not** authorize changing the shipped verifier default (that requires the Anthropic-path A/B).');
  lines.push('');
}
lines.push(`provider: ${provider} · drafts: \`${draftsPath}\` · truth: \`${truthPath}\` (${truthN} rows)` + (limit ? ` · --limit ${limit}` : ''));
lines.push(`joined n per arm: ${arms.map((x) => `${x.mode}=${x.score.n}`).join(' · ')} (identical id sets — enforced)`);
if (partialCoverage) {
  lines.push('');
  lines.push(`> ⚠️ **Partial coverage** — arms score ${ref.joinedIds.size}/${truthN} ground-truth rows (smoke/subset run). Directionally useful, NOT decision-grade: rerun the full set before flipping any default.`);
}
lines.push('');
lines.push(`| metric | ${cols.map((c) => c.name).join(' | ')} |`);
lines.push(`|---|${cols.map(() => '---').join('|')}|`);
metricNames.forEach((mn, i) => lines.push(`| ${mn} | ${cols.map((c) => cell(c.cells[i])).join(' | ')} |`));
if (confArm?.sweep) {
  lines.push('');
  lines.push('## confidence τ-sweep');
  lines.push('');
  lines.push('| τ | flag% | let-through major% | recall% | precision% | gate |');
  lines.push('|---|---|---|---|---|---|');
  for (const s of confArm.sweep) {
    lines.push(`| ${s.tau} | ${s.flagRatePct} | ${s.letThroughMajorPct} (${s.letThroughMajorN}/${s.cleanN}) | ${s.recallPct} | ${s.precisionPct} | ${s.gatePass ? 'PASS' : 'fail'} |`);
  }
  lines.push('');
  lines.push(confArm.best
    ? `Recommended operating point: **τ = ${confArm.best.tau}** (fewest flags meeting gate ≤10% + recall ≥80%).`
    : 'No τ meets gate ≤10% + recall ≥80%.');
}
lines.push('');
lines.push(`## Recommendation`);
lines.push('');
if (partialCoverage) lines.push('⚠️ Smoke-run caveat: partial coverage — do NOT act on this without a full-set rerun.');
if (provider === 'openai') lines.push('ℹ️ OpenAI-path result — informational for the OpenAI BYOK experience; the shipped default stays decided by the Anthropic-path A/B.');
lines.push(recommendation);
lines.push('');
lines.push(`Reproduce: \`bun precision-ab.ts${provider === 'openai' ? ' --provider openai' : ''} --score-only\` (same vfy-out files) — full re-run needs the key.`);
lines.push('');

const report = lines.join('\n');
writeFileSync(outPath, report);
console.log('\n' + report);
console.error(`[precision-ab] report → ${outPath}`);
