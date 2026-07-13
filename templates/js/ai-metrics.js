// ai-metrics.js — ②-B accept-rate / edit-distance store (D8 / Codex#8).
//
// v1's ONLY quality signal is the human's own accept/edit/reject behavior on real
// AI drafts (the LLM-judge eval is deferred to v2). Those metrics need to PERSIST
// across reloads to be a signal, but must NEVER touch the corpus/overlay/export
// (that would pollute the trip data). So they live in a SEPARATE IndexedDB
// database — same isolation pattern fsa.js uses for the directory handle.
//
// Plain ES module (NOT TypeScript). The pure core (editDistance + summarize) is
// unit-tested; the IDB layer is best-effort and NEVER throws (Safari private mode
// / quota just degrades to no-op, like the rest of the bundle).
//
// Event shape (append-only):
//   { ts, venueKey, venueId, action: 'accepted'|'rejected', editDistance, model }
//   editDistance = 0 when accepted unchanged, >0 when accepted after editing,
//   0 for rejected (not counted toward the accepted edit-distance average).

const DB_NAME = 'trip-ai-metrics';   // SEPARATE DB — not the overlay's, not fsa's
const STORE = 'events';

// ---- pure core (testable) ---------------------------------------------------

// Levenshtein distance — how far the human moved the AI draft. The honest signal:
// 0 = accepted verbatim (AI nailed the family lens), large = heavy rewrite.
export function editDistance(a, b) {
  const s = String(a == null ? '' : a);
  const t = String(b == null ? '' : b);
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  let cur = new Array(t.length + 1);
  for (let i = 1; i <= s.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[t.length];
}

// Roll events up into the quality read shown in-UI / logged. acceptRate is the
// headline; avgEditDistance is over ACCEPTED drafts only (a rejected draft has no
// meaningful "how much did you change it").
export function summarize(events) {
  const ev = Array.isArray(events) ? events : [];
  let accepted = 0, rejected = 0, edited = 0, distSum = 0;
  for (const e of ev) {
    if (!e || typeof e !== 'object') continue;
    if (e.action === 'accepted') {
      accepted++;
      const d = Number(e.editDistance) || 0;
      distSum += d;
      if (d > 0) edited++;
    } else if (e.action === 'rejected') {
      rejected++;
    }
  }
  const total = accepted + rejected;
  return {
    total,
    accepted,
    rejected,
    edited,                                                    // accepted-after-editing count
    acceptRate: total ? accepted / total : 0,
    avgEditDistance: accepted ? distSum / accepted : 0,
  };
}

// ---- IDB layer (best-effort, never throws) ----------------------------------
function idbAvailable() {
  try { return typeof indexedDB !== 'undefined' && indexedDB !== null; }
  catch (_) { return false; }
}
function openDb() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, 1); }
    catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('ai-metrics idb open failed'));
    req.onblocked = () => reject(new Error('ai-metrics idb open blocked'));
  });
}

// Append one event. Best-effort: a quota/private-mode failure is swallowed (the
// metric is a nice-to-have signal, never a blocker). `nowMs` is injectable so the
// caller stamps the time (the modules avoid Date.now() at import scope per house rule).
export async function recordMetric(event, nowMs) {
  if (!event || typeof event !== 'object' || !idbAvailable()) return false;
  const row = {
    ts: typeof nowMs === 'number' ? nowMs : null,
    venueKey: event.venueKey ?? null,
    venueId: event.venueId != null ? String(event.venueId) : null,
    action: event.action === 'accepted' ? 'accepted' : 'rejected',
    editDistance: Number(event.editDistance) || 0,
    model: event.model ?? null,
  };
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).add(row);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('ai-metrics tx aborted'));
    });
    db.close();
    return true;
  } catch (_) { return false; }   // degrade silently
}

// Read all recorded events. Never throws → returns [] on any failure.
export async function readMetrics() {
  if (!idbAvailable()) return [];
  try {
    const db = await openDb();
    const out = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => reject(req.error || new Error('ai-metrics getAll failed'));
    });
    db.close();
    return out;
  } catch (_) { return []; }
}

// Convenience: the rolled-up quality read. Never throws.
export async function summarizeMetrics() {
  return summarize(await readMetrics());
}
