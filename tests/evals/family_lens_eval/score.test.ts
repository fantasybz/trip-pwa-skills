// score.test.ts — pure unit tests for the family_lens_eval scorer + gate.
// (Not an LLM eval — safe to run in CI. The expensive harness lives in run.ts/
// judge.ts, which are NOT *.test.ts and are never collected by `bun test`.)
import { test, expect } from 'bun:test';
import { score, checkGate, GATE, type Venue, type Draft, type Verdict } from './score.ts';

const VALID = '有兒童椅、推車友善,離車站近,適合帶小孩的家庭。';   // passes validateDraft

const venues: Venue[] = [
  { id: 'good', corpus: 'food', regime: 'cold' },
  { id: 'realhall', corpus: 'food', regime: 'cold' },
  { id: 'badfail', corpus: 'food', regime: 'cold' },     // draft fails validateDraft
  { id: 'missing', corpus: 'food', regime: 'cold' },      // no draft + no verdict
];
const drafts: Draft[] = [
  { id: 'good', why_picked: VALID },
  { id: 'realhall', why_picked: VALID },
  { id: 'badfail', why_picked: '' },                      // empty → validateDraft fails
];
const verdicts: Verdict[] = [
  { idx: 0, name: 'good', verdict: 'accept', hallucination: false, severity: 'none', reason: 'ok' },
  { idx: 1, name: 'realhall', verdict: 'reject', hallucination: true, severity: 'major', reason: 'fabricated' },
  { idx: 2, name: 'badfail', verdict: 'reject', hallucination: true, severity: 'major', reason: 'also major' },
  // idx 3 ('missing') intentionally absent
];

test('majorHallucinationRate excludes validator-failed drafts (Codex #8 conflation)', () => {
  const { metrics } = score(venues, drafts, verdicts);
  expect(metrics.n).toBe(4);
  // ONLY 'realhall' (validatorOk + major) counts — NOT 'badfail' (invalid draft,
  // never ships) nor 'missing' (no verdict). 1/4 = 25%, not the pre-fix 2/4 = 50%.
  expect(metrics.majorHallucinationRate).toBe(25);
  expect(metrics.hallucinationRate).toBe(25);            // badfail's hallucination also excluded
  expect(metrics.validatorFailRate).toBe(50);            // badfail + missing
  expect(metrics.acceptRate).toBe(25);                   // only 'good'
});

test('missing verdict scores as no-verdict (no positional fallback, severity none)', () => {
  const { rows } = score(venues, drafts, verdicts);
  const missing = rows.find((r) => r.id === 'missing')!;
  expect(missing.severity).toBe('none');
  expect(missing.accepted).toBe(false);
  expect(missing.verdict).toBe('reject');                // defaulted, did NOT borrow row[3]
});

test('checkGate fails on high major-hallucination, passes when clean', () => {
  const failing = score(venues, drafts, verdicts).metrics;
  expect(checkGate(failing).pass).toBe(false);           // 25% > 10%

  const cleanVenues: Venue[] = [{ id: 'a', corpus: 'food', regime: 'cold' }];
  const cleanDrafts: Draft[] = [{ id: 'a', why_picked: VALID }];
  const cleanVerdicts: Verdict[] = [{ idx: 0, name: 'a', verdict: 'accept', hallucination: false, severity: 'none', reason: 'ok' }];
  const passing = score(cleanVenues, cleanDrafts, cleanVerdicts).metrics;
  expect(passing.majorHallucinationRate).toBe(0);
  expect(passing.acceptRate).toBe(100);
  expect(checkGate(passing).pass).toBe(true);
  expect(GATE.maxMajorHallucinationRate).toBe(0.10);     // documents the threshold
});
