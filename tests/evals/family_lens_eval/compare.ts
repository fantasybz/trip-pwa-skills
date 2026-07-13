// compare.ts — A/B the guard arm against the baseline on the SAME venues.
//
// The guard arm ran on a 153-venue subset (113 cold + 40 hook-seeded control).
// For a clean comparison we restrict the baseline's 319 rows to those same ids,
// then diff the headline metrics. Usage: bun compare.ts
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pct, fmtDelta, readJsonl } from './eval-lib.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const base = JSON.parse(readFileSync(resolve(HERE, 'report.baseline.json'), 'utf8'));
const guard = JSON.parse(readFileSync(resolve(HERE, 'report.guard.json'), 'utf8'));
const sub = readJsonl(resolve(HERE, 'venues.guard-subset.jsonl'));
const subIds = new Set(sub.map((v: any) => String(v.id)));

function metricsOf(rows: any[]) {
  const m = (f: (r: any) => boolean) => { const s = rows.filter(f); return { n: s.length, accept: pct(s.filter((r) => r.accepted).length, s.length) }; };
  return {
    n: rows.length,
    accept: pct(rows.filter((r) => r.accepted).length, rows.length),
    hall: pct(rows.filter((r) => r.hallucination).length, rows.length),
    major: pct(rows.filter((r) => r.severity === 'major').length, rows.length),
    cold: m((r) => r.regime === 'cold'),
    hook: m((r) => r.regime === 'hook-seeded'),
  };
}
// baseline restricted to the guard-subset ids → same-set A/B
const baseSub = metricsOf(base.rows.filter((r: any) => subIds.has(String(r.id))));
const guardM = metricsOf(guard.rows);

console.log(`\n══ family_lens_eval A/B — guard vs baseline, SAME ${baseSub.n} venues (113 cold + 40 hook control) ══`);
console.log(`metric                       baseline → guard      Δ`);
console.log(`accept-rate                  ${baseSub.accept}%  →  ${guardM.accept}%     ${fmtDelta(baseSub.accept, guardM.accept)}`);
console.log(`hallucination-rate           ${baseSub.hall}%  →  ${guardM.hall}%     ${fmtDelta(baseSub.hall, guardM.hall)}`);
console.log(`MAJOR-hallucination-rate     ${baseSub.major}%  →  ${guardM.major}%     ${fmtDelta(baseSub.major, guardM.major)}   ← the gate metric`);
console.log(`  cold accept (n=${baseSub.cold.n})         ${baseSub.cold.accept}%  →  ${guardM.cold.accept}%     ${fmtDelta(baseSub.cold.accept, guardM.cold.accept)}`);
console.log(`  hook accept (n=${baseSub.hook.n})          ${baseSub.hook.accept}%  →  ${guardM.hook.accept}%     ${fmtDelta(baseSub.hook.accept, guardM.hook.accept)}   (no-regression check)`);
console.log(`\nfull-corpus baseline (n=${base.metrics.n}): accept ${base.metrics.acceptRate}%  major-hall ${base.metrics.majorHallucinationRate}%  gate ${base.gate.pass ? 'PASS' : 'FAIL'}`);
console.log(`guard arm (n=${guard.metrics.n}):        accept ${guard.metrics.acceptRate}%  major-hall ${guard.metrics.majorHallucinationRate}%  gate ${guard.gate.pass ? 'PASS' : 'FAIL'}`);
