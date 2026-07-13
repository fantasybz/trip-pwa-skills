# verify-pass precision experiment (default vs strict vs confidence)

**Status:** harness ready, **not yet run** (needs an Anthropic key + `codex` on
PATH — see _Run it_). This doc is the protocol + the decision rule; the runner
writes a paste-ready results file (`precision-ab.results.md`) — copy it into the
Results section after running.

## The problem

The shipped v3 verify-pass (`templates/js/ai-verify.js`, wired live in v0.9.0 as
the advisory ⚠️ 查無依據 warning) clears the eval gate but is **high-recall,
low-precision**:

| metric (2026-06-15, n=318 baseline drafts) | value |
|---|---|
| major-hallucination, before verify | 20.1% |
| major-hallucination, AFTER verify (let-through) | **4.7% → GATE PASS (≤10%)** |
| verifier recall on real majors | 92.2% |
| verifier **precision / flag-rate** | **45% / 66.4%** |

It flags ~2 of every 3 drafts, and only ~45% of those flags are real majors. On
the live surface that is **alarm fatigue**: a warning that fires on two-thirds of
enriched venues stops being read. We want fewer, higher-confidence flags —
without pushing let-through-major back over the 10% gate.

## The levers (both opt-in, default byte-identical — unit-tested)

1. **`strict`** — `buildVerifySystem({ strict })` appends `VERIFY_STRICT_CLAUSE`:
   flag only high-confidence fabrications, treat reasonable category/area
   inferences as supported, never flag tone/degree words. A blunter prompt:
   precision bought with recall, one operating point per run.
2. **`confidence`** — `buildVerifySystem({ confidence })` +
   `verifyToolSchema({ confidence: true })`: the verifier still lists EVERY
   unsupported claim but scores each `{ claim, confidence: 0–1 }`; the consumer
   thresholds in JS (flag iff any claim ≥ τ). **One scored run yields the whole
   precision/recall curve post-hoc** — the τ-sweep re-scores in milliseconds, no
   re-prompting per operating point. This is the fallback the v1 protocol named
   ("confidence-scored verifier… threshold in JS") — now staged as a first-class
   arm so a single key session settles both levers.

`callVerify(v, d, { strict: true })` / `{ confidence: true }` thread them.
**Nothing on the live surface changes until this experiment justifies a flip** —
the live wiring passes no opts, and the default prompt/schema/return shape are
locked byte-identical by `templates/js-tests/ai-verify.test.ts`.

## Run it

```bash
cd trip-pwa-skills/tests/evals/family_lens_eval

# 0. ONCE: ground truth + baseline drafts (the existing harness — see README.md)
ANTHROPIC_API_KEY=sk-ant-... bun run.ts --arm baseline --generate anthropic --judge codex
#    → report.baseline.json (Codex ground truth) + drafts.baseline.jsonl
#      (drafts are auto-dumped in generate mode since v0.10.2 — before that the
#      flow dead-ended on precision-ab's drafts prerequisite)

# 1. the whole 3-arm A/B, scored + decided, in one command:
ANTHROPIC_API_KEY=sk-ant-... bun precision-ab.ts
#    smoke first if you want:  … bun precision-ab.ts --limit 40
#    resume after a crash:      … bun precision-ab.ts --reuse
#    re-score without the key:  bun precision-ab.ts --score-only
```

All arms verify the SAME drafts against the SAME Codex ground truth, so the
deltas are pure prompt/threshold effect (one generation, no judge variance).
`precision-ab.ts` runs `verify-run.ts` per arm, scores with the shared
`eval-lib.scoreVerify` math, τ-sweeps the confidence arm, applies the decision
rule below, and writes `precision-ab.results.md`. Per-arm plumbing
(`verify-run.ts --mode …` + `verify-pass.ts --vfy …`) still works standalone.

**No false-greens by construction:** any per-row verify failure makes
`verify-run.ts` exit 3 (partial file kept, orchestrator aborts); every requested
arm file must exist and parse; all arms must join the IDENTICAL ground-truth id
set (a stale `--reuse` smoke file or crashed partial arm hard-fails); without
`--limit` that set must cover every draft with ground truth; a flag-everything
operating point (0 let-through rows) is never "gate pass"; and `--limit` smoke
reports carry an explicit not-decision-grade caveat on the recommendation.

## Results (paste `precision-ab.results.md` here after running)

| metric | default | strict | confidence@τ* |
|---|---|---|---|
| flag-rate (UX cost) | 66.4% | _?_ | _?_ |
| precision (flagged that truly hallucinate) | 45% | _?_ | _?_ |
| recall on real majors | 92.2% | _?_ | _?_ |
| let-through major (GATE ≤10%) | 4.7% | _?_ | _?_ |

## OpenAI-path variant (informational — never flips the shipped default)

The same 3-arm experiment can run over the **OpenAI BYOK path** (the config an
OpenAI-key user actually lives with: `gpt-4o-mini` generates and self-verifies):

```bash
OPENAI_API_KEY=sk-...  bun run.ts --arm baseline --generate openai --judge codex
OPENAI_API_KEY=sk-...  bun precision-ab.ts --provider openai
```

Mechanics: Bun has no CORS, so the harness calls `api.openai.com` directly
through a fetch-boundary shim (`eval-lib.openAiDirectOpts` — a reserved-TLD
sentinel base that passes the SHIPPED validator, rewritten at the fetch call).
The browser contract is untouched: in the generated app, OpenAI stays
proxy-only and `resolveOpenAiChatUrl` still fail-fasts on `api.openai.com`.
All OpenAI-path artifacts carry a `.oai` marker in the default filenames
(`drafts.baseline.oai.jsonl`, `report.baseline.oai.json`,
`vfy-out.<mode>.oai.jsonl`, `precision-ab.oai.results.md`), and — because
explicit `--drafts/--truth/--out` overrides could bypass filenames — every
artifact also embeds `provider` metadata (draft rows, the report, vfy rows)
that `run.ts`/`verify-run.ts`/`precision-ab.ts` hard-check against the run's
`--provider`. Mixing paths fails with exit 2, never a mislabeled report.

**Interpretation limit:** the ground-truth judge (Codex) shares a model family
with the OpenAI generator/verifier, so judge independence is weaker than the
canonical sonnet-generates / Codex-judges setup. Use the OpenAI-path numbers to
characterize the OpenAI BYOK experience (how noisy is ⚠️ there, does the
verifier behave sanely); the decision rule below applies **only** to the
Anthropic-path A/B.

## Decision rule

A candidate = the strict arm, or the confidence arm at its recommended τ*
(τ* = fewest flags among τ values meeting rules 1+3; `pickOperatingPoint`).
Flip the live default to the winning candidate **iff ALL hold**:

1. **let-through major ≤ 10%** — the gate must still pass. Hard stop.
2. **flag-rate drops materially** (target ≤ ~45%) — the whole point is less noise.
3. **recall stays ≥ ~80%** — precision is bought with recall; below ~80% the
   verifier misses too many real fabrications to be worth the quieter warning.

Among candidates passing all three, **fewest flags wins** (tie → higher
precision). The flip itself is one line each:

- strict → `ai-enrich.js` passes `{ strict: true }` to `callVerify`.
- confidence@τ → `ai-enrich.js` passes `{ confidence: true }` and drops claims
  below τ before rendering the ⚠️ list (τ lives next to the call site as a
  named const).

If nothing passes (1)+(3) → keep default; the noise is the price of the gate.
If a candidate passes (1)+(3) but barely moves flag-rate → not worth a prompt
change; re-examine the τ-sweep table for a better operating point before giving
up (that table is free — no new API calls).
