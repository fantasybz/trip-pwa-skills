// run.ts — family_lens_eval orchestrator.
//
//   load gold venues → GENERATE drafts → JUDGE (Codex) → SCORE + GATE → report.
//
// Generation adapters:
//   --generate anthropic   real ai.js callEnrich (needs ANTHROPIC_API_KEY + fetch);
//                          also DUMPS the drafts to --drafts (default
//                          drafts.<arm>.jsonl) so verify-run/precision-ab can
//                          re-verify the same drafts
//   --generate file        precomputed drafts.jsonl ({id, why_picked, kid_friendly?})
//                          — used when no Anthropic key (drive sonnet out-of-band,
//                          key results back by id)
// Judge adapters:
//   --judge codex          run Codex (default; needs `codex` on PATH + OpenAI auth)
//   --judge file           precomputed verdicts json ({verdicts:[...]})
//
// Examples:
//   bun run.ts --arm guard --generate anthropic --judge codex
//   bun run.ts --arm baseline --generate file --drafts drafts.baseline.jsonl --judge codex
//
// Exits non-zero if the gate fails (major-hallucination-rate / accept-rate).

import { writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assemble, loadVenues, FEW_SHOT, type Arm, type Venue } from './assemble.ts';
import { score, checkGate } from './score.ts';
import { judge as codexJudge } from './judge.ts';
import { parseArg, buildJudgeItem } from './eval-lib.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const a = (f: string, d?: string) => parseArg(process.argv, f, d);

const arm = (a('--arm', 'guard') as Arm);
const inPath = resolve(HERE, a('--in', 'venues.jsonl')!);
const genMode = a('--generate', 'file')!;
const judgeMode = a('--judge', 'codex')!;
const limit = a('--limit') ? Number(a('--limit')) : Infinity;
if (a('--limit') && !Number.isFinite(limit)) { console.error(`--limit must be a number (got ${a('--limit')})`); process.exit(2); }
// Partial runs must not overwrite the canonical full-run artifacts: with
// --limit, the DEFAULT output filenames gain a .limit<N> marker (an explicit
// --drafts/--out path is the user's conscious choice). precision-ab.ts reads
// the unsuffixed defaults, so a smoke run can never pose as the full baseline.
const partialSuffix = Number.isFinite(limit) ? `.limit${limit}` : '';

let venues: Venue[] = loadVenues(inPath).slice(0, limit);
console.error(`[run] arm=${arm} venues=${venues.length} generate=${genMode} judge=${judgeMode}`);

// ---- generate ----------------------------------------------------------------
type Draft = { id: string; why_picked: string; kid_friendly?: boolean };
let drafts: Draft[];
const genFailed: string[] = [];

if (genMode === 'anthropic') {
  const ai = await import('../../../templates/js/ai.js');
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { console.error('ANTHROPIC_API_KEY required for --generate anthropic'); process.exit(2); }
  (globalThis as any).sessionStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  ai.setKey(key);
  drafts = [];
  for (const v of venues) {
    const guard = arm !== 'baseline';
    const r = await ai.callEnrich(v, FEW_SHOT, { guard });
    if (r.ok) drafts.push({ id: v.id, ...r.draft });
    // A generation failure (API error) is NOT a draft — don't push a fake empty
    // why_picked that score.ts would conflate with a model-returned-bad-output
    // validator failure. Leave it out (score.ts marks the venue 'no-draft') and
    // surface a distinct failure summary so a bad run isn't read as a real result.
    else { console.error(`  gen fail ${v.id}: ${r.error}`); genFailed.push(String(v.id)); }
  }
  if (genFailed.length) console.error(`[run] ⚠️ ${genFailed.length}/${venues.length} generation failures (no draft scored): ${genFailed.join(', ')}`);
  // Dump the generated drafts to disk. Without this, --generate anthropic left
  // NO drafts file, so the documented precision-ab flow dead-ended on its own
  // prerequisite (precision-ab re-verifies the SAME drafts under each arm from
  // drafts.<arm>.jsonl). In generate mode --drafts is the OUTPUT path; in file
  // mode (below) it is the input.
  const draftsOut = resolve(HERE, a('--drafts', `drafts.${arm}${partialSuffix}.jsonl`)!);
  writeFileSync(draftsOut, drafts.map((d) => JSON.stringify(d)).join('\n') + (drafts.length ? '\n' : ''));
  console.error(`[run] dumped ${drafts.length} drafts → ${draftsOut}`);
} else {
  const path = resolve(HERE, a('--drafts', `drafts.${arm}.jsonl`)!);
  drafts = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  console.error(`[run] loaded ${drafts.length} drafts from ${path}`);
}

// ---- judge -------------------------------------------------------------------
const byId = new Map(drafts.map((d) => [String(d.id), d]));
const judgeInput = venues.map((v, i) => buildJudgeItem(v, byId.get(String(v.id)), i));

let verdicts;
if (judgeMode === 'file') {
  const path = resolve(HERE, a('--verdicts', `verdicts.${arm}.json`)!);
  verdicts = JSON.parse(readFileSync(path, 'utf8')).verdicts;
} else {
  verdicts = codexJudge(judgeInput);
}

// ---- score + gate ------------------------------------------------------------
const { metrics, rows } = score(venues, drafts, verdicts);
const gate = checkGate(metrics);
const report = { arm, generatedWith: genMode, judgedWith: judgeMode, gate, metrics, rows };
const outPath = resolve(HERE, a('--out', `report.${arm}${partialSuffix}.json`)!);
writeFileSync(outPath, JSON.stringify(report, null, 2));

const m = metrics;
console.log(`\n══ family_lens_eval — arm=${arm} (n=${m.n}) ══`);
console.log(`accept-rate              ${m.acceptRate}%   (gate ≥ 75%)`);
console.log(`hallucination-rate       ${m.hallucinationRate}%`);
console.log(`MAJOR-hallucination-rate ${m.majorHallucinationRate}%   (GATE ≤ 10%)  ← the metric that matters`);
console.log(`validator-fail-rate      ${m.validatorFailRate}%`);
console.log(`by regime:  cold ${m.byRegime.cold.acceptRate}% (n=${m.byRegime.cold.n})   hook-seeded ${m.byRegime['hook-seeded'].acceptRate}% (n=${m.byRegime['hook-seeded'].n})`);
console.log(`by corpus:  ` + Object.entries(m.byCorpus).map(([c, s]) => `${c} ${s.acceptRate}%(${s.n})`).join('   '));
console.log(`GATE: ${gate.pass ? 'PASS ✅' : 'FAIL ❌ — ' + gate.fails.join('; ')}`);
console.log(`report → ${outPath}`);
if (genFailed.length) {
  // Outputs above cover only the successful subset — usable for inspection,
  // NOT a canonical baseline. Non-zero so orchestration/docs flows don't
  // treat a partial run as the real thing (mirrors verify-run.ts exit 3).
  console.error(`[run] ❌ partial run — ${genFailed.length} generation failures; exiting 3.`);
  process.exit(3);
}
process.exit(gate.pass ? 0 : 1);
