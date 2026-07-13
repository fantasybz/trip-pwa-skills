// verify-regime-guard.ts — paired A/B for the regime-aware guard (v2).
//
// The first A/B judged baseline and guard in SEPARATE Codex runs, so the hook
// regression was confounded by judge variance. This judges BOTH arms in ONE
// Codex call (same rubric, same run) over the same 90-venue sample (30 cold +
// 60 hook), so the per-arm delta is the prompt effect, not run noise.
//
//   bun verify-regime-guard.ts
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDraft } from '../../../templates/js/ai-validate.js';
import { judge as codexJudge } from './judge.ts';
import { pct, fmtDelta, readJsonl as jl, buildJudgeItem } from './eval-lib.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
// Transient drafts live in the repo's gitignored .context/dogfood (4 levels up:
// family_lens_eval → evals → tests → trip-pwa-skills → repo root). Resolve
// relative to this file so the one-shot re-run works on any machine/workspace.
const DF = resolve(HERE, '../../../../.context/dogfood');

const venues = jl(resolve(HERE, 'verify-sample.jsonl'));
const baseById = new Map(jl(`${DF}/drafts.verify-baseline.jsonl`).map((d: any) => [String(d.id), d]));
const guardById = new Map(
  ['drafts-vguard-0.jsonl', 'drafts-vguard-1.jsonl']
    .flatMap((f) => { try { return jl(`${DF}/gen/${f}`); } catch { return []; } })
    .map((d: any) => [String(d.id), d]),
);

// keep only venues that have BOTH arms' drafts → a clean paired comparison
const paired = venues.filter((v: any) => baseById.has(String(v.id)) && guardById.has(String(v.id)));

const ARMS = ['baseline', 'guard'] as const;
const meta: { arm: string; venue: any; draft: any }[] = [];
const judgeInput: any[] = [];
for (const arm of ARMS) {
  for (const v of paired) {
    const draft = (arm === 'baseline' ? baseById : guardById).get(String(v.id));
    meta.push({ arm, venue: v, draft });
    judgeInput.push(buildJudgeItem(v, draft, meta.length - 1));
  }
}
console.error(`[verify] ${paired.length} paired venues × 2 arms = ${judgeInput.length} items, one Codex run`);
const verdicts = codexJudge(judgeInput);          // returns verdicts with global idx
const vById = new Map(verdicts.map((x: any) => [x.idx, x]));

function metricsFor(arm: string) {
  const rows = meta.map((m, i) => ({ m, v: vById.get(i) })).filter((r) => r.m.arm === arm);
  const acc = (f: (r: any) => boolean) => { const s = rows.filter(f); return { n: s.length, accept: pct(s.filter((r) => validateDraft(r.m.draft).ok && r.v?.verdict === 'accept').length, s.length) }; };
  return {
    accept: pct(rows.filter((r) => validateDraft(r.m.draft).ok && r.v?.verdict === 'accept').length, rows.length),
    major: pct(rows.filter((r) => r.v?.severity === 'major').length, rows.length),
    hall: pct(rows.filter((r) => r.v?.hallucination).length, rows.length),
    cold: acc((r) => r.m.venue.regime === 'cold'),
    hook: acc((r) => r.m.venue.regime === 'hook-seeded'),
  };
}
const b = metricsFor('baseline'), g = metricsFor('guard');
console.log(`\n══ regime-aware guard — PAIRED A/B (same Codex run), n=${paired.length} (30 cold + 60 hook) ══`);
console.log(`metric                       baseline → guard      Δ`);
console.log(`accept-rate                  ${b.accept}%  →  ${g.accept}%     ${fmtDelta(b.accept, g.accept)}`);
console.log(`hallucination-rate           ${b.hall}%  →  ${g.hall}%     ${fmtDelta(b.hall, g.hall)}`);
console.log(`MAJOR-hallucination-rate     ${b.major}%  →  ${g.major}%     ${fmtDelta(b.major, g.major)}   ← gate metric`);
console.log(`  cold accept (n=${b.cold.n})          ${b.cold.accept}%  →  ${g.cold.accept}%     ${fmtDelta(b.cold.accept, g.cold.accept)}`);
console.log(`  hook accept (n=${b.hook.n})          ${b.hook.accept}%  →  ${g.hook.accept}%     ${fmtDelta(b.hook.accept, g.hook.accept)}   (was −12.5 in the noisy split-run A/B)`);
