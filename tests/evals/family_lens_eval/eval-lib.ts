// eval-lib.ts — shared helpers for the family_lens_eval scripts.
//
// run.ts / assemble.ts / compare.ts / verify-pass.ts / verify-regime-guard.ts
// had each grown their own copy of the same argv reader, percentage helper,
// delta formatter, jsonl loader, and judge-item shape. Five copies of a
// one-liner drift independently; this is the single source of truth. Pure +
// dependency-free so it's safe to import from any eval script, and unit-tested
// in eval-lib.test.ts (the per-script copies never were).

import { readFileSync } from 'node:fs';

// --argv reader: parseArg(argv, '--flag', fallback). Returns the token AFTER
// the flag, or the fallback when the flag is absent — OR when the flag was given
// without a value (the next token is itself a `--flag`). Without that guard,
// `verify-run.ts --drafts --mode strict` would read a file literally named
// `--mode`, and `--limit --out x` would Number('--out')→NaN and verify zero rows:
// a value-less flag must fall back, never silently consume the next flag (these
// scripts make gate decisions, so a misparse must not pass as a clean run).
export function parseArg(argv: string[], flag: string, fallback?: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? fallback : v;
}

// Percentage to one decimal place; 0 when the denominator is 0 (no NaN in a
// report). pct(1, 4) === 25, pct(0, 0) === 0.
export function pct(n: number, d: number): number {
  return d ? Math.round((1000 * n) / d) / 10 : 0;
}

// Signed one-decimal delta for the A/B tables: fmtDelta(80, 90) === '+10',
// fmtDelta(90, 80) === '-10', fmtDelta(80, 80) === '+0'.
export function fmtDelta(a: number, b: number): string {
  const x = Math.round((b - a) * 10) / 10;
  return (x >= 0 ? '+' : '') + x;
}

// Read a .jsonl file → array of parsed objects (blank lines skipped).
export function readJsonl<T = any>(path: string): T[] {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
}

// ---- verify-pass scoring (shared by verify-pass.ts + precision-ab.ts) ---------
// The formulas are verbatim from the shipped v3 verify-pass measurement (see
// RESULTS.md): joined = rows with ground truth; flag-rate over joined; the GATE
// metric is major-rate among LET-THROUGH (clean) drafts; recall over real majors;
// precision = flagged that truly hallucinate (any severity). Extracted here so
// the τ-sweep and the 3-arm A/B score with the exact same math as the historical
// single-arm report — and so the math is unit-testable without a key.

export type VerifyClaim = { claim: string; confidence: number };
export type VerifyRow = {
  id: string | number;
  verdict: 'clean' | 'has_unsupported';
  unsupported: string[];
  claims?: VerifyClaim[];          // present only for confidence-mode rows
};
export type TruthRowLike = { validatorOk?: boolean; severity?: string; hallucination?: boolean };

export const isMajor = (r: TruthRowLike | undefined) => !!(r && r.validatorOk && r.severity === 'major');
export const isHall = (r: TruthRowLike | undefined) => !!(r && r.validatorOk && r.hallucination);

// Normalize a raw `claims` array from a vfy-out row (verify-run.ts --mode
// confidence): keep only well-formed {claim, confidence} entries, clamp
// confidence to [0,1]. Returns undefined when the field is absent — the marker
// of a binary row. Shared by verify-pass.ts + precision-ab.ts so both loaders
// build identical VerifyRows.
export function normalizeScoredClaims(raw: unknown): VerifyClaim[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .filter((c: any) => c && typeof c === 'object' && typeof c.claim === 'string' && typeof c.confidence === 'number' && Number.isFinite(c.confidence))
    .map((c: any) => ({ claim: c.claim, confidence: Math.min(1, Math.max(0, c.confidence)) }));
}

// Row verdict at threshold τ: a confidence-scored row flags iff ANY claim clears
// τ (≥). Binary rows (no claims[]) keep their model verdict — τ never bites on
// them, so mixing modes in one file scores each row by what it actually carries.
export function verdictAtTau(row: VerifyRow, tau?: number): 'clean' | 'has_unsupported' {
  if (tau === undefined || !Array.isArray(row.claims)) return row.verdict;
  return row.claims.some((c) => c.confidence >= tau) ? 'has_unsupported' : 'clean';
}

export type VerifyScore = {
  tau?: number;
  n: number;                                        // rows joined with ground truth
  flaggedN: number; cleanN: number; flagRatePct: number;
  beforeMajorN: number; beforeMajorPct: number;     // real majors among all joined
  letThroughMajorN: number; letThroughMajorPct: number;  // GATE metric (majors among clean)
  recallCaughtN: number; recallPct: number;         // flagged ∩ major / beforeMajorN
  precisionHallN: number; precisionPct: number;     // flagged ∩ hallucination / flaggedN
  gatePass: boolean;                                // letThroughMajorPct ≤ 10
};

export function scoreVerify(rows: VerifyRow[], truth: Map<string, TruthRowLike>, tau?: number): VerifyScore {
  const joined = rows.filter((r) => truth.has(String(r.id)));
  const flagged = joined.filter((r) => verdictAtTau(r, tau) === 'has_unsupported');
  const clean = joined.filter((r) => verdictAtTau(r, tau) === 'clean');
  const majors = joined.filter((r) => isMajor(truth.get(String(r.id))));
  const cleanMajor = clean.filter((r) => isMajor(truth.get(String(r.id))));
  const flaggedMajor = flagged.filter((r) => isMajor(truth.get(String(r.id))));
  const flaggedHall = flagged.filter((r) => isHall(truth.get(String(r.id))));
  const letThroughMajorPct = pct(cleanMajor.length, clean.length);
  return {
    ...(tau === undefined ? {} : { tau }),
    n: joined.length,
    flaggedN: flagged.length, cleanN: clean.length, flagRatePct: pct(flagged.length, joined.length),
    beforeMajorN: majors.length, beforeMajorPct: pct(majors.length, joined.length),
    letThroughMajorN: cleanMajor.length, letThroughMajorPct,
    recallCaughtN: flaggedMajor.length, recallPct: pct(flaggedMajor.length, majors.length),
    precisionHallN: flaggedHall.length, precisionPct: pct(flaggedHall.length, flagged.length),
    // cleanN === 0 → pct(0,0) = 0, which would read as a perfect gate with ZERO
    // let-through evidence (e.g. a τ that flags everything). No clean rows = no
    // gate evidence = NOT a pass (Codex xhigh P2).
    gatePass: clean.length > 0 && letThroughMajorPct <= 10,
  };
}

export function sweepVerify(rows: VerifyRow[], truth: Map<string, TruthRowLike>, taus: number[]): VerifyScore[] {
  return taus.map((t) => scoreVerify(rows, truth, t));
}

// The experiment's decision rule (docs/verify-precision-experiment.md), applied
// to a set of candidate operating points: feasible = still passes the gate AND
// keeps enough recall; among feasible, fewest flags wins (that's the whole point),
// precision then higher-τ as tie-breakers. Returns null when nothing is feasible
// (= keep the shipped default; the noise is the price of the gate).
export function pickOperatingPoint(
  scores: VerifyScore[],
  opts: { gateMaxPct?: number; minRecallPct?: number } = {},
): VerifyScore | null {
  const gateMaxPct = opts.gateMaxPct ?? 10;
  const minRecallPct = opts.minRecallPct ?? 80;
  // cleanN > 0: a flag-everything operating point has NO let-through evidence —
  // its pct(0,0)=0 "gate" is vacuous, never feasible.
  const feasible = scores.filter((s) => s.cleanN > 0 && s.letThroughMajorPct <= gateMaxPct && s.recallPct >= minRecallPct);
  feasible.sort(
    (a, b) =>
      a.flagRatePct - b.flagRatePct ||
      b.precisionPct - a.precisionPct ||
      (b.tau ?? 0) - (a.tau ?? 0),
  );
  return feasible[0] ?? null;
}

// The exact item shape the Codex judge consumes (run.ts + verify-regime-guard.ts
// built this identically). `model_was_given` mirrors EXACTLY the fields the
// generator received (null = not given) so the judge can tell invented specifics
// from grounded ones. `idx` is the judge's positional key (score.ts matches on it).
export type JudgeVenue = {
  id?: string; corpus?: string; name: string;
  category?: string | null; area?: string | null; address?: string | null;
  hours?: string | null; existing_why?: string | null;
  regime?: 'cold' | 'hook-seeded';
};
export type JudgeDraft = { why_picked?: string; kid_friendly?: boolean | null };
export function buildJudgeItem(venue: JudgeVenue, draft: JudgeDraft | undefined, idx: number) {
  return {
    idx,
    corpus: venue.corpus,
    regime: venue.regime === 'cold' ? 'cold(sparse-input)' : 'hook-seeded(rewrite)',
    name: venue.name,
    model_was_given: {
      name: venue.name,
      category: venue.category ?? null,
      area: venue.area ?? null,
      address: venue.address ?? null,
      hours: venue.hours ?? null,
      existing_why: venue.existing_why || null,
    },
    ai_draft: draft?.why_picked ?? '',
    ai_kid_friendly: draft?.kid_friendly ?? null,
  };
}
