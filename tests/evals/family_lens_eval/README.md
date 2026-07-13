# family_lens_eval

A re-runnable eval for the ②-B BYOK AI `why_picked` enrich feature. It answers
the question the unit tests can't: **does the AI draft fabricate?** — and gates on
that, not on prose niceness.

## Why this exists

The 2026-06-14 dogfood (16 real thin venues, drafts on `claude-sonnet-4-6`, judged
by Codex) found an **81% accept-rate that masked 6/16 fabricated drafts** —
invented 推車友善 / 份量 / cuisine-type / 抹茶蜜, none in the input. A naive "is it
nice" judge passes all 16. So the gate metric here is the **major-hallucination
rate** (unsupported specific claims), with accept-rate as a secondary signal.

The dogfood also found the cause: the system prompt's own *"具體(例如兒童椅、推車
友善…)"* instruction induces fabrication on **thin** input (a venue with no
`category`/`area`/`existing_why`). The `ai.js` grounding guard (shipped default)
counters it; this eval A/Bs `--arm baseline` (guard off) vs `--arm guard`.

## Pipeline

```
venues.jsonl ──assemble (real ai.js builders)──▶ prompts
            ──generate (sonnet-4-6)──▶ drafts ──validateDraft gate──▶
            ──judge (Codex / independent)──▶ verdicts ──score + GATE──▶ report
```

- **Generator** = `claude-sonnet-4-6` (the real production model).
- **Judge** = Codex (OpenAI) — a DIFFERENT model family on purpose: an independent
  base won't rubber-stamp the generator's blind spots, and its world-knowledge
  catches category errors (it flagged 與ろゐ屋, a ramen shop the draft called an
  izakaya). `judge.ts` forces structured output via `--output-schema`.
- Prompt assembly imports `buildSystem` / `buildUserContent` from
  `templates/js/ai.js` — the eval **cannot drift** from the shipped prompt.

## Files

| File | Role |
|---|---|
| `venues.jsonl` | committed gold set — 319 real Tokyo venues (food/desserts/attractions/fandom), normalized to the model-input shape + regime (cold vs hook-seeded) |
| `build-fixtures.ts` | regen `venues.jsonl` from a trip's content dir (`--source`) |
| `assemble.ts` | real-builder prompt assembly per arm; `--dump` to a prompts file |
| `judge.ts` | Codex judge (batched, schema-forced) |
| `score.ts` | validateDraft gate + accept / hallucination / major-hallucination rates + `GATE` |
| `run.ts` | orchestrator: generate → judge → score → `report.<arm>.json`, exit≠0 on gate fail |
| `verify-run.ts` | run the verifier (`ai-verify.callVerify`) over baseline drafts → `vfy-out.<mode>.jsonl`; `--mode strict` for the precision lever |
| `verify-pass.ts` | score a verify pass vs the Codex ground truth (flag-rate / precision / recall / let-through major + GATE); `--vfy <file> --label <name>` |

## Run it

End-to-end (needs an Anthropic key for live generation + `codex` on PATH):

```bash
ANTHROPIC_API_KEY=sk-ant-... bun run.ts --arm guard --generate anthropic --judge codex
ANTHROPIC_API_KEY=sk-ant-... bun run.ts --arm baseline --generate anthropic --judge codex
```

No Anthropic key? Generate out-of-band on sonnet-4-6 and feed the drafts in
(`drafts.<arm>.jsonl`, one `{"id","why_picked","kid_friendly"?}` per line):

```bash
bun assemble.ts --arm baseline --out prompts.baseline.json   # → drive sonnet over .items
bun run.ts --arm baseline --generate file --drafts drafts.baseline.jsonl --judge codex
```

Quick subset: add `--limit 20`. Re-score without re-judging: `--judge file --verdicts verdicts.<arm>.json`.

## The gate

`score.ts` `GATE`: **major-hallucination-rate ≤ 10%** AND accept-rate ≥ 75%.
`run.ts` exits non-zero when the gate fails — so it can fence a future v2
"AI-on-by-default" decision. This is a measurement harness (LLM calls are
non-deterministic + cost money), NOT a CI unit test — it lives outside the
`bun test skills/ templates/js-tests/` globs and is run on demand.

## Baseline (2026-06-14, full 319, generated on sonnet-4-6, judged by Codex)

See `report.baseline.json` / `report.guard.json` and `../../../../.context/dogfood/FINDINGS.md`
for the run that motivated the guard.
