// venue-entry.ts — the single source of truth for a corpus entry's SHAPE.
//
// Both food-ingest (auto-route on ingest, v0.5.1) and placement-promote (manual
// promote, v0.5) turn a source venue into a corpus entry. Before this module they
// each built the shape inline → drift risk between "ingested directly" and
// "promoted later". buildVenueEntry is the one place the shape is decided.
//
// food.json keeps the full v0.2.3 shape (category / kid_friendly / anchor /
// backup_fit + on-the-ground detail). NON-food corpora get the GENERIC subset
// only — injecting food-only fields onto a 景點/周邊 row is wrong data (codex #6,
// v0.5). `name_jp_or_local` is common, not food-only: every foreign-city venue
// may need its local-script name for search/on-the-ground use. The renderer
// reads the common subset defensively, so the generic shape renders everywhere.

export interface VenueFields {
  id: string;
  name_zh: string;
  name_jp_or_local?: string;
  day_keys: string[];
  anchor?: string;
  category?: string;
  kid_friendly?: boolean;
  source_url: string;
  source_platform: string;
  extraction_method: string;
  why_picked: string;
  backup_fit?: string;
  address: string;
  hours: string;
  price: string;
  maps_query: string;
  last_verified: string;
}

export interface CandidateVenueOverrides {
  id?: string;
  day?: string;
  anchor?: string;
  category?: string;
  why?: string;
  kidFriendly?: boolean;
  today?: string;
  fallbackToday?: string;
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (text) return text;
  }
  return '';
}

function boolish(value: unknown): boolean {
  return value === true || value === 'true';
}

// One candidate normalizer for both Bun placement-promote and the generated
// browser edit mode. Candidate files predate several aliases, so accepting
// day-hint/url/dashed fields in only one runtime silently changed promoted data.
export function candidateToVenueFields(
  value: unknown,
  overrides: CandidateVenueOverrides = {},
): VenueFields {
  const cand = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const candidateDays = Array.isArray(cand.day_keys)
    ? cand.day_keys.map((day) => firstText(day)).filter(Boolean)
    : (() => {
        const day = firstText(cand.day_hint, cand['day-hint'], cand.day);
        return day ? [day] : [];
      })();
  const dayKeys = overrides.day !== undefined
    ? (firstText(overrides.day) ? [firstText(overrides.day)] : [])
    : candidateDays;
  const textOverride = (key: 'anchor' | 'category' | 'why', ...fallback: unknown[]) =>
    overrides[key] !== undefined ? firstText(overrides[key]) : firstText(...fallback);
  const idValue = overrides.id ?? cand.id;

  return {
    id: idValue == null ? '' : String(idValue),
    name_zh: firstText(cand.name_zh, cand.name) || '(unnamed)',
    name_jp_or_local: firstText(cand.name_jp_or_local, cand.local_name, cand['name-jp']),
    day_keys: dayKeys,
    anchor: textOverride('anchor', cand.anchor),
    category: textOverride('category', cand.category),
    kid_friendly: overrides.kidFriendly !== undefined
      ? overrides.kidFriendly
      : boolish(cand.kid_friendly ?? cand['kid-friendly']),
    source_url: firstText(cand.source_url, cand.url),
    source_platform: firstText(cand.source_platform) || 'manual',
    extraction_method: firstText(cand.extraction_method) || 'manual',
    why_picked: textOverride('why', cand.why_picked, cand.why, cand.hook),
    backup_fit: firstText(cand.backup_fit, cand['backup-fit']),
    address: firstText(cand.address),
    hours: firstText(cand.hours),
    price: firstText(cand.price),
    maps_query: firstText(cand.maps_query, cand['maps-query']),
    last_verified: firstText(overrides.today, cand.last_verified, cand.last_seen, overrides.fallbackToday),
  };
}

// Field ORDER is kept byte-for-byte stable (existing food.json entries + the
// placement-promote tests assert it). Do not reorder.
export function buildVenueEntry(to: string, f: VenueFields): Record<string, unknown> {
  // GENERIC subset — every venue corpus reads these; non-food corpora get ONLY these.
  const generic = {
    id: f.id,
    name_zh: f.name_zh || '(unnamed)',
    name_jp_or_local: f.name_jp_or_local || '',
    day_keys: f.day_keys || [],
    source_url: f.source_url || '',
    source_platform: f.source_platform || 'manual',
    extraction_method: f.extraction_method || 'manual',
    why_picked: f.why_picked || '',
    maps_query: f.maps_query || '',
    address: f.address || '',
    hours: f.hours || '',
    price: f.price || '',
    last_verified: f.last_verified,
  };
  if (to !== 'food') return generic;

  // food.json — full v0.2.3 shape.
  return {
    id: generic.id,
    name_zh: generic.name_zh,
    name_jp_or_local: generic.name_jp_or_local,
    day_keys: generic.day_keys,
    anchor: f.anchor || '',
    category: f.category || 'restaurant',
    kid_friendly: !!f.kid_friendly,
    source_url: generic.source_url,
    source_platform: generic.source_platform,
    extraction_method: generic.extraction_method,
    why_picked: generic.why_picked,
    backup_fit: f.backup_fit || '',
    address: generic.address,
    hours: generic.hours,
    price: generic.price,
    maps_query: generic.maps_query,
    last_verified: generic.last_verified,
  };
}
