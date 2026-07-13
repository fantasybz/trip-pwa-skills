// eval-lib.test.ts — unit tests for the shared eval helpers. These functions
// were duplicated verbatim across 5 eval scripts and never tested; centralizing
// them in eval-lib.ts makes this coverage possible (and guards the buildJudgeItem
// shape the Codex judge depends on).
import { test, expect } from 'bun:test';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseArg, pct, fmtDelta, readJsonl, buildJudgeItem,
  isMajor, isHall, verdictAtTau, scoreVerify, sweepVerify, pickOperatingPoint,
  type VerifyRow, type TruthRowLike, type VerifyScore,
} from './eval-lib.ts';

test('parseArg returns the token after the flag, or the fallback', () => {
  const argv = ['bun', 'run.ts', '--arm', 'guard', '--limit', '50'];
  expect(parseArg(argv, '--arm', 'baseline')).toBe('guard');
  expect(parseArg(argv, '--limit')).toBe('50');
  expect(parseArg(argv, '--missing', 'def')).toBe('def');
  expect(parseArg(argv, '--missing')).toBeUndefined();
  // a flag given without a value must NOT consume the next flag as its value
  expect(parseArg(['x', '--drafts', '--mode', 'strict'], '--drafts', 'def.jsonl')).toBe('def.jsonl');
  expect(parseArg(['x', '--limit', '--out', 'r.json'], '--limit')).toBeUndefined();
});

test('pct: one-decimal percentage, 0 on zero denominator (no NaN)', () => {
  expect(pct(1, 4)).toBe(25);
  expect(pct(1, 3)).toBe(33.3);
  expect(pct(0, 0)).toBe(0);     // never NaN in a report
  expect(pct(5, 5)).toBe(100);
});

test('fmtDelta: signed one-decimal delta', () => {
  expect(fmtDelta(80, 90)).toBe('+10');
  expect(fmtDelta(90, 80)).toBe('-10');
  expect(fmtDelta(80, 80)).toBe('+0');
  expect(fmtDelta(66.7, 90)).toBe('+23.3');
});

test('readJsonl parses non-blank lines, skips blanks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-lib-'));
  const p = join(dir, 'x.jsonl');
  writeFileSync(p, '{"id":"a"}\n\n{"id":"b"}\n');
  expect(readJsonl(p)).toEqual([{ id: 'a' }, { id: 'b' }]);
});

test('buildJudgeItem: stable judge shape; null-fills missing model facts', () => {
  const venue = { id: 'f1', corpus: 'food', name: '冷門小店', address: '東京', regime: 'cold' as const };
  const item = buildJudgeItem(venue, { why_picked: '份量足' }, 3);
  expect(item.idx).toBe(3);
  expect(item.corpus).toBe('food');
  expect(item.regime).toBe('cold(sparse-input)');
  expect(item.ai_draft).toBe('份量足');
  expect(item.ai_kid_friendly).toBe(null);
  // model_was_given mirrors EXACTLY what the generator got — unknowns are null,
  // not absent, so the judge can distinguish "not given" from invented.
  expect(item.model_was_given).toEqual({
    name: '冷門小店', category: null, area: null, address: '東京', hours: null, existing_why: null,
  });
});

test('buildJudgeItem: hook-seeded regime label + missing draft → empty ai_draft', () => {
  const venue = { id: 'd1', corpus: 'desserts', name: '老舖', existing_why: '排隊名店', regime: 'hook-seeded' as const };
  const item = buildJudgeItem(venue, undefined, 0);
  expect(item.regime).toBe('hook-seeded(rewrite)');
  expect(item.ai_draft).toBe('');               // no draft → empty string, not undefined
  expect(item.model_was_given.existing_why).toBe('排隊名店');
});

// ---- verify-pass scoring ------------------------------------------------------

const TRUTH = new Map<string, TruthRowLike>([
  ['a', { validatorOk: true, severity: 'major', hallucination: true }],
  ['b', { validatorOk: true, severity: 'minor', hallucination: true }],
  ['c', { validatorOk: true, severity: 'none', hallucination: false }],
  ['d', { validatorOk: false, severity: 'major', hallucination: true }],   // validator-failed → excluded from major/hall
  ['e', { validatorOk: true, severity: 'major', hallucination: true }],
  ['f', { validatorOk: true, severity: 'none', hallucination: false }],
]);

const bin = (id: string, verdict: 'clean' | 'has_unsupported'): VerifyRow => ({ id, verdict, unsupported: verdict === 'clean' ? [] : ['x'] });
const scored = (id: string, confs: number[]): VerifyRow => ({
  id,
  verdict: confs.length ? 'has_unsupported' : 'clean',
  unsupported: confs.map((_, i) => `c${i}`),
  claims: confs.map((c, i) => ({ claim: `c${i}`, confidence: c })),
});

test('isMajor/isHall: validatorOk gates both; missing row is neither', () => {
  expect(isMajor(TRUTH.get('a'))).toBe(true);
  expect(isMajor(TRUTH.get('b'))).toBe(false);   // minor
  expect(isMajor(TRUTH.get('d'))).toBe(false);   // validatorOk false
  expect(isHall(TRUTH.get('d'))).toBe(false);
  expect(isHall(TRUTH.get('b'))).toBe(true);
  expect(isMajor(undefined)).toBe(false);
  expect(isHall(undefined)).toBe(false);
});

test('verdictAtTau: τ bites only on scored rows; τ comparison is inclusive (≥)', () => {
  const b1 = bin('a', 'has_unsupported');
  expect(verdictAtTau(b1)).toBe('has_unsupported');
  expect(verdictAtTau(b1, 0.99)).toBe('has_unsupported');   // binary row ignores τ
  const s1 = scored('a', [0.7]);
  expect(verdictAtTau(s1)).toBe('has_unsupported');          // no τ → model verdict
  expect(verdictAtTau(s1, 0.7)).toBe('has_unsupported');     // 0.7 ≥ 0.7
  expect(verdictAtTau(s1, 0.71)).toBe('clean');
  expect(verdictAtTau(scored('x', []), 0)).toBe('clean');    // empty claims never flag
});

test('scoreVerify: hand-computed binary fixture — every count and pct', () => {
  const rows: VerifyRow[] = [
    bin('a', 'has_unsupported'),   // catches major a
    bin('b', 'has_unsupported'),   // flags minor-hall b
    bin('c', 'clean'),
    bin('d', 'has_unsupported'),   // validator-failed truth: counts in flags, not in precision
    bin('e', 'clean'),             // LETS THROUGH major e
    bin('f', 'clean'),
    bin('zz', 'has_unsupported'),  // no ground truth → dropped from the join
  ];
  const s = scoreVerify(rows, TRUTH);
  expect(s.n).toBe(6);
  expect(s.flaggedN).toBe(3);
  expect(s.cleanN).toBe(3);
  expect(s.flagRatePct).toBe(50);
  expect(s.beforeMajorN).toBe(2);            // a, e (d excluded by validatorOk)
  expect(s.beforeMajorPct).toBe(33.3);
  expect(s.letThroughMajorN).toBe(1);        // e slipped through
  expect(s.letThroughMajorPct).toBe(33.3);   // 1/3 clean
  expect(s.gatePass).toBe(false);
  expect(s.recallCaughtN).toBe(1);           // caught a of {a,e}
  expect(s.recallPct).toBe(50);
  expect(s.precisionHallN).toBe(2);          // a,b of 3 flags (d's truth is validator-failed)
  expect(s.precisionPct).toBe(66.7);
  expect(s.tau).toBeUndefined();
});

test('scoreVerify + sweepVerify: τ moves the flag/clean split on scored rows only', () => {
  const rows: VerifyRow[] = [
    scored('a', [0.9]),
    scored('b', [0.6]),
    scored('c', []),
    scored('e', [0.3]),            // real major flagged only at low confidence
    scored('f', [0.55]),
  ];
  // τ=0.5: flags a,b,f — major e slips through → gate FAIL at 50% of 2 clean… (e,c clean)
  const at05 = scoreVerify(rows, TRUTH, 0.5);
  expect(at05).toMatchObject({ tau: 0.5, n: 5, flaggedN: 3, cleanN: 2, letThroughMajorN: 1, letThroughMajorPct: 50, gatePass: false, recallPct: 50 });
  // τ=0.25: e's 0.3 clears → all majors caught, gate 0%, flag-rate 80%
  const at025 = scoreVerify(rows, TRUTH, 0.25);
  expect(at025).toMatchObject({ tau: 0.25, flaggedN: 4, cleanN: 1, letThroughMajorN: 0, letThroughMajorPct: 0, gatePass: true, recallPct: 100, flagRatePct: 80, precisionPct: 75 });
  // τ=0.95: nothing flags → both majors let through
  const at095 = scoreVerify(rows, TRUTH, 0.95);
  expect(at095).toMatchObject({ flaggedN: 0, cleanN: 5, letThroughMajorN: 2, letThroughMajorPct: 40, gatePass: false, recallPct: 0 });
  // τ=0: EVERYTHING flags → 0 clean rows → pct(0,0)=0 must NOT read as a gate
  // pass (no let-through evidence). Codex xhigh P2 regression lock.
  const at0 = scoreVerify(rows.filter((r) => r.claims!.length), TRUTH, 0);
  expect(at0).toMatchObject({ cleanN: 0, letThroughMajorPct: 0, gatePass: false });
  // sweep = same scores in τ order
  const sweep = sweepVerify(rows, TRUTH, [0.25, 0.5, 0.95]);
  expect(sweep.map((s) => s.tau)).toEqual([0.25, 0.5, 0.95]);
  expect(sweep[0]).toEqual(at025);
  // a binary row mixed into a scored file keeps its verdict at every τ
  const mixed = scoreVerify([...rows, bin('d', 'has_unsupported')], TRUTH, 0.95);
  expect(mixed.flaggedN).toBe(1);            // only the binary flag survives τ=0.95
});

test('pickOperatingPoint: fewest flags among gate+recall-feasible; ties → precision, then higher τ; none → null', () => {
  const mk = (p: Partial<VerifyScore>): VerifyScore => ({
    n: 100, flaggedN: 50, cleanN: 50, flagRatePct: 0, beforeMajorN: 0, beforeMajorPct: 0,
    letThroughMajorN: 0, letThroughMajorPct: 0, recallCaughtN: 0, recallPct: 0,
    precisionHallN: 0, precisionPct: 0, gatePass: true, ...p,
  });
  const s1 = mk({ tau: 0.5, letThroughMajorPct: 8, recallPct: 85, flagRatePct: 40, precisionPct: 60 });
  const s2 = mk({ tau: 0.7, letThroughMajorPct: 9, recallPct: 82, flagRatePct: 30, precisionPct: 70 });
  const s3 = mk({ tau: 0.9, letThroughMajorPct: 12, recallPct: 70, flagRatePct: 20, precisionPct: 90 });  // fails gate + recall
  expect(pickOperatingPoint([s1, s2, s3])).toEqual(s2);
  // tie on flag-rate → precision wins
  const t1 = mk({ tau: 0.6, letThroughMajorPct: 5, recallPct: 90, flagRatePct: 30, precisionPct: 55 });
  expect(pickOperatingPoint([t1, s2])).toEqual(s2);
  // full tie → higher τ (quieter at equal cost)
  const u1 = mk({ tau: 0.6, letThroughMajorPct: 5, recallPct: 90, flagRatePct: 30, precisionPct: 70 });
  expect(pickOperatingPoint([u1, s2])).toEqual(s2);
  // nothing feasible → null (keep the shipped default)
  expect(pickOperatingPoint([s3])).toBeNull();
  // thresholds are configurable
  expect(pickOperatingPoint([s3], { gateMaxPct: 15, minRecallPct: 60 })).toEqual(s3);
  // flag-everything (cleanN 0) has a vacuous 0% gate → never feasible, even
  // with perfect recall (Codex xhigh P2 regression lock)
  const flagAll = mk({ tau: 0.05, cleanN: 0, flaggedN: 100, flagRatePct: 100, letThroughMajorPct: 0, recallPct: 100, gatePass: false });
  expect(pickOperatingPoint([flagAll])).toBeNull();
  expect(pickOperatingPoint([flagAll, s2])).toEqual(s2);
});
