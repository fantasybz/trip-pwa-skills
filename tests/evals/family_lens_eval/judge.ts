// judge.ts — the independent accept/reject judge (Codex / OpenAI, by design).
//
// Why a DIFFERENT model family than the generator (claude-sonnet-4-6): a judge
// that shares the generator's training base rubber-stamps its own blind spots.
// Codex (OpenAI) gives an independent read, and its world-knowledge catches
// category errors the generator can't see (dogfood: it flagged 與ろゐ屋 — a ramen
// shop the draft wrote up as an izakaya). Requires `codex` on PATH + OpenAI auth.
//
// Batches the venue set (a few hundred items in one call risks truncation),
// forces structured output via --output-schema, and merges the chunks.

import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Verdict } from './score.ts';

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['idx', 'name', 'verdict', 'hallucination', 'severity', 'reason'],
        properties: {
          idx: { type: 'integer' }, name: { type: 'string' },
          verdict: { type: 'string', enum: ['accept', 'reject'] },
          hallucination: { type: 'boolean' },
          severity: { type: 'string', enum: ['none', 'minor', 'major'] },
          reason: { type: 'string' },
        },
      },
    },
  },
};

const PROMPT = (inputPath: string) => `You are an INDEPENDENT reviewer standing in for a Taiwanese parent travelling to Tokyo with a 5-year-old. You evaluate an AI feature that drafts a \`why_picked\` line (1–3 短句) for venues on a family shortlist; your accept/reject simulates whether this parent would tap 接受. The aggregate is the feature's accept-rate — be a discerning real user.

Read \`${inputPath}\`. It is an array of venues, each with:
- \`model_was_given\`: EXACTLY the facts the model received (null = not given).
- \`regime\`: cold(sparse-input) or hook-seeded(rewrite).
- \`ai_draft\`: the drafted why_picked.

Judge each on, in priority order:
1. HALLUCINATION (most important): does the draft assert concrete specifics NEITHER in \`model_was_given\` NOR genuine well-known public fact about THIS exact named venue (invented 兒童椅/推車友善/buffet/menu/floor/queue/dates/開幕年份/cuisine-type)? Be strict — unverifiable specific ⇒ hallucination. Set \`hallucination:true\`.
2. FAMILY-LENS USEFULNESS: concrete + useful to a parent (location, 份量, kid appeal, stroller/seat, queue) vs generic fluff.
3. VOICE/GRANULARITY: matches the user's terse concrete voice; overlong/florid ⇒ a parent would trim.
4. FOR hook-seeded ONLY: is the rewrite at least as faithful + useful as the original existing_why? Penalize information loss or added unverifiable detail.

Decision: \`reject\` on a MAJOR hallucination, OR generic/useless, OR (hook-seeded) a rewrite worse than the original. A MINOR hallucination a parent would shrug off can still be \`accept\` but flag \`hallucination:true\` + \`severity:minor\`. \`accept\` only if the parent would genuinely keep it.

Output STRICTLY per the schema: an object with a \`verdicts\` array, one item per venue in idx order, each { idx, name, verdict, hallucination, severity (none|minor|major), reason (ONE concise zh-TW sentence naming the specific issue or strength) }. Do not modify files. Do not write code.`;

export function judge(judgeInput: any[], chunkSize = 60): Verdict[] {
  const dir = mkdtempSync(join(tmpdir(), 'fle-judge-'));
  const schemaPath = join(dir, 'schema.json');
  writeFileSync(schemaPath, JSON.stringify(SCHEMA));
  const all: Verdict[] = [];
  for (let start = 0; start < judgeInput.length; start += chunkSize) {
    const chunk = judgeInput.slice(start, start + chunkSize).map((v, k) => ({ ...v, idx: k }));
    const inputPath = join(dir, `in-${start}.json`);
    const outPath = join(dir, `out-${start}.json`);
    writeFileSync(inputPath, JSON.stringify(chunk, null, 2));
    process.stderr.write(`  judging ${start}..${start + chunk.length - 1} (${chunk.length})…\n`);
    // Per-chunk isolation: a codex non-zero exit / missing-output-file / parse
    // error must NOT abort the whole run and lose every accumulated chunk. Log,
    // skip this chunk's verdicts, continue — score.ts scores the gap as
    // no-verdict (severity 'none'), so a flaky chunk can't inflate the gate.
    try {
      execFileSync('codex', [
        'exec', '-s', 'read-only',
        '--output-schema', schemaPath,
        '--output-last-message', outPath,
        '--color', 'never',
        PROMPT(inputPath),
      ], { stdio: ['ignore', 'ignore', 'inherit'], maxBuffer: 64 * 1024 * 1024 });
      const parsed = JSON.parse(readFileSync(outPath, 'utf8'));
      // re-offset idx back to the global position
      for (const v of parsed.verdicts) all.push({ ...v, idx: start + v.idx });
    } catch (e) {
      const msg = (e && (e as any).message) || String(e);
      process.stderr.write(`  ⚠️ chunk @${start} judge failed (${msg}) — skipping ${chunk.length} verdicts (scored as no-verdict)\n`);
    }
  }
  return all;
}
