# trip-pwa-skills — advanced conventions (a11y catalogue)

The full accessibility convention catalogue ported from the 2026-tokyo-family-
travel PWA into the generated templates. `CLAUDE.md` states the baseline
("behavioral, not cosmetic"); this doc is the mechanism — what each convention
is, where it lives in `templates/`, and how to extend a surface without
breaking it. `launch-check` runs every bundle-owned Playwright spec against the
generated app's static files: `a11y.spec.ts` verifies the behavioral trio (focus-visible,
tablist arrow nav, synthetic-click), while the other specs cover the render
loop, edit mode, and AI enrich. A CSS grep proves nothing about behavior.

## Focus-ring system (`templates/css/base.css` + `tokens.css`)

Tokens: `--focus-ring-color` (accent), `--focus-ring-color-on-dark`,
`--focus-ring-width: 2px`, `--focus-ring-offset: 2px`.

- **Universal ring**: `:focus-visible { outline: … }`. Outline, NOT
  `box-shadow` — cards/chips use box-shadow for their selected states, and a
  shadow-based ring would clobber them.
- **Compound guards**: `:focus-visible:active`, `:disabled:focus-visible`,
  `[aria-disabled="true"]:focus-visible` → `outline-color: transparent`. The
  ring must not flash during a press or on a disabled control.
- **Bottom-nav special case**: `#bottom-nav button:focus-visible` swaps to a
  top-edge `box-shadow: inset`. An outline outside a fixed button at the
  safe-area edge clips into the iOS home-indicator zone.
- **Old Safari (<15.4)**: `@supports not selector(:focus-visible)` reverts to
  the UA `:focus` outline. Never leave old Safari ringless.
- **Forced colors (Windows HC)**: `@media (forced-colors: active)` swaps the
  ring to system `Highlight`; the bottom-nav case goes back to a real outline
  there (inset shadows are flattened in forced-colors mode).
- **Reduced motion**: `@media (prefers-reduced-motion: reduce)` strips ALL
  transitions/animations globally — focus indication appears instantly.

When adding a component with its own selected-state shadow: do nothing — the
outline ring composes with it. Never add a per-component focus style unless the
component is fixed-positioned at a screen edge (then follow the bottom-nav
pattern).

## Tablist arrow-key nav (`templates/js/app.js` `tablistArrowNav`)

Click-driven: ArrowLeft/Right finds the next tab, calls `tab.click()`, then
refocuses on the next frame — so it works no matter what the click handler does
(full re-render, in-place mutation, anything). Wired to the day strip
(`#day-strip` / `.day-chip`, `role="tablist"` set in `render.js`).

To add a new tab strip: give the container `role="tablist"`, the tabs a common
selector, and call `tablistArrowNav(container, '.your-tab')` once after first
render. Don't hand-roll per-strip keydown logic.

## Synthetic-click rows (`templates/js/app.js` `setupSyntheticClick`)

Any non-`<button>`/`<a>` click target needs `role="button"` + `tabindex="0"` +
an `aria-label`. One global Enter/Space keydown handler converts keyboard
activation into `click()` for exactly those elements — no per-row listeners.
When you render a new clickable `<li>`/`<div>`, set the three attributes and
you're covered; real `<button>`s are deliberately excluded (they activate
natively).

## CJK wrap scoping (`templates/css/app.css`)

`overflow-wrap: anywhere` is applied **per component subtree, never on
`body`** — overflow-wrap inherits, and a body-level rule regresses descendants
you didn't audit (Tokyo PR #295 lesson, recorded at the top of `base.css`).
Chips/labels that must not break use `white-space: nowrap` locally. When a new
surface shows long CJK+URL mixed strings, add `overflow-wrap: anywhere` on that
surface's class, not higher.

Body typography is CJK-tuned in `base.css`: Hiragino Sans / Noto Sans TC, 17px,
line-height 1.55 (CJK needs more leading than Latin's 1.4).

## Disclosures

- Native `<details class="prep-collapse">` for the prep-refs card — free
  keyboard/AT semantics, no JS.
- JS-driven disclosures (edit-mode "more" menu, `ai-enrich.js`) maintain
  `aria-expanded` on the trigger and close siblings before opening — copy that
  pattern (`ai-enrich.js:102-117`) for new popovers. Collapse-state
  *persistence* (the Tokyo app remembers per-day open state) is not yet a
  template behavior; if a generated surface grows sticky disclosures, persist
  per-key like the Tokyo `prep_contingency_open_<day>_<kind>` convention.

## Verifying

`bun skills/_lib/launch-check.ts --out <trip-dir> --quality family` runs the
duplicate-ref audit, portable content-depth floor, all bundle-owned
`templates/tests/**/*.spec.ts` behavior checks, and trusted-only
`tests/playwright-trusted/**/*.spec.ts` harness checks. The browser suite
includes a11y (focus ring, arrow navigation, synthetic click), render-loop,
edit-mode, AI-enrich, and network-isolation behavior. The audited trip's config, tests, and
`node_modules` are never executed. Missing bundle Playwright fails closed;
`--no-browser-tests` is an explicit partial check, not publish qualification
(`--no-a11y` remains a deprecated full-suite skip alias). Run it after any
change to generated browser behavior, including `templates/js/app.js`,
`render.js`, edit mode, AI enrich, or the focus CSS. Unit halves live in
`templates/js-tests/` (`bun run test` from the bundle root).
