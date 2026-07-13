// app.js — entry point. Registers the service worker, renders, and wires the
// shared a11y handlers: tablist arrow-key nav + Enter/Space synthetic-click for
// non-button click targets. Ported behavior from 2026-tokyo-family-travel.

import { renderApp } from './render.js';
import { initEditMode } from './edit-mode.js';

// ---- Service worker registration ----
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) =>
      console.warn('SW registration failed:', err.message)
    );
  });
}

// ---- Tablist arrow-key navigation ----
// Click-driven (tab.click() + refocus next frame) so it works regardless of how
// the click handler re-renders. Wired to the day-strip tablist.
function tablistArrowNav(root, tabSelector) {
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const tabs = Array.from(root.querySelectorAll(tabSelector));
    const current = document.activeElement;
    const idx = tabs.indexOf(current);
    if (idx === -1) return;
    e.preventDefault();
    const next = e.key === 'ArrowRight'
      ? (idx + 1) % tabs.length
      : (idx - 1 + tabs.length) % tabs.length;
    tabs[next].click();
    requestAnimationFrame(() => tabs[next].focus());
  });
}

// ---- Enter/Space synthetic-click for [role="button"][tabindex="0"] ----
// Converts keyboard activation into click() for non-<button>/<a> click targets.
function setupSyntheticClick() {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.getAttribute('role') !== 'button' || t.getAttribute('tabindex') !== '0') return;
    if (t.tagName === 'BUTTON' || t.tagName === 'A') return;
    e.preventDefault();
    t.click();
  });
}

async function main() {
  setupSyntheticClick();
  const strip = document.getElementById('day-strip');
  // renderApp() targets the index shell (#day-strip / #app-header / #prep-host /
  // #bottom-nav). day.html is a static shell until weekend 2 — without the
  // schedule scaffold renderApp would null-deref (Codex P2). Page-gate on it.
  if (!strip) return;
  tablistArrowNav(strip, '.day-chip');
  // Wire the ②-A edit-mode controller BEFORE renderApp so its render.js hooks
  // (onReady / onVenuesRendered) are registered when renderApp fires them.
  initEditMode();
  await renderApp();
}

main();
