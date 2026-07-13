// score.ts — the eval's metric + gate.
//
// Runs every draft through the REAL validateDraft gate (a draft that fails it
// would never reach the user, so it counts as a non-accept), then aggregates the
// Codex verdicts into the headline numbers. The GATE metric is the
// MAJOR-HALLUCINATION RATE, not prose niceness: the 2026-06-14 dogfood showed an
// 81% accept-rate that masked 6/16 fabricated drafts, so "is it nice" is the
// wrong gate — "did it invent unsupported specifics" is the one that matters.

import { validateDraft } from '../../../templates/js/ai-validate.js';
import { pct } from './eval-lib.ts';

export type Draft = { id: string; why_picked: string; kid_friendly?: boolean };
export type Verdict = {
  idx: number; name: string; verdict: 'accept' | 'reject';
  hallucination: boolean; severity: 'none' | 'minor' | 'major'; reason: string;
};
export type Venue = { id: string; corpus: string; regime: 'cold' | 'hook-seeded' };

// Gate thresholds. A run that exceeds maxMajorHallucinationRate OR falls below
// minAcceptRate fails the gate (run.ts exits non-zero). Tuned from the dogfood:
// the pre-guard baseline runs ~19% major-hallucination → fails; the guard must
// pull it under 10%.
export const GATE = { maxMajorHallucinationRate: 0.10, minAcceptRate: 0.75 };

export function score(venues: Venue[], drafts: Draft[], verdicts: Verdict[]) {
  const byId = new Map(drafts.map((d) => [String(d.id), d]));
  const rows = venues.map((v, i) => {
    const draft = byId.get(String(v.id));
    const gate = draft ? validateDraft(draft) : { ok: false, reason: 'no-draft' };
    // Match the verdict by idx ONLY — NO positional `|| verdicts[i]` fallback: if
    // the judge drops/misorders one item, borrowing a neighbour's verdict silently
    // corrupts every downstream row. A genuinely missing verdict scores as
    // no-verdict (severity 'none' → NOT counted as a hallucination, NOT accepted),
    // so a flaky judge can't inflate the gate metric.
    const vd = verdicts.find((x) => x.idx === i) || null;
    // A draft that fails validateDraft can never be accepted in-app.
    const accepted = gate.ok && vd?.verdict === 'accept';
    return {
      idx: i, id: v.id, corpus: v.corpus, regime: v.regime,
      validatorOk: gate.ok, validatorReason: (gate as any).reason,
      verdict: vd?.verdict ?? 'reject', hallucination: !!vd?.hallucination,
      severity: vd?.severity ?? 'none', accepted, reason: vd?.reason ?? '(no verdict)',
    };
  });

  const n = rows.length;
  const slice = (f: (r: typeof rows[number]) => boolean) => {
    const s = rows.filter(f);
    return { n: s.length, acceptRate: pct(s.filter((r) => r.accepted).length, s.length) };
  };
  const metrics = {
    n,
    acceptRate: pct(rows.filter((r) => r.accepted).length, n),
    validatorFailRate: pct(rows.filter((r) => !r.validatorOk).length, n),
    // Hallucination rates count ONLY deliverable drafts (validatorOk): a draft that
    // fails validateDraft never reaches the user, so a judge 'major' on it is a
    // generation failure, NOT a shipped hallucination — counting it would conflate
    // the two and could falsely fail the gate (Codex #8). Validator failures are
    // already surfaced separately by validatorFailRate + a lower acceptRate.
    hallucinationRate: pct(rows.filter((r) => r.validatorOk && r.hallucination).length, n),
    majorHallucinationRate: pct(rows.filter((r) => r.validatorOk && r.severity === 'major').length, n),
    byRegime: {
      cold: slice((r) => r.regime === 'cold'),
      'hook-seeded': slice((r) => r.regime === 'hook-seeded'),
    },
    byCorpus: Object.fromEntries(
      ['food', 'desserts', 'attractions', 'fandom'].map((c) => [c, slice((r) => r.corpus === c)]),
    ),
  };
  return { metrics, rows };
}

export function checkGate(m: { majorHallucinationRate: number; acceptRate: number }) {
  const fails: string[] = [];
  if (m.majorHallucinationRate / 100 > GATE.maxMajorHallucinationRate)
    fails.push(`major-hallucination ${m.majorHallucinationRate}% > ${GATE.maxMajorHallucinationRate * 100}%`);
  if (m.acceptRate / 100 < GATE.minAcceptRate)
    fails.push(`accept-rate ${m.acceptRate}% < ${GATE.minAcceptRate * 100}%`);
  return { pass: fails.length === 0, fails };
}
