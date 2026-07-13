// venue-entry.ts — the single source of truth for a corpus entry's SHAPE.
//
// Both food-ingest (auto-route on ingest, v0.5.1) and placement-promote (manual
// promote, v0.5) turn a source venue into a corpus entry. Before this module they
// each built the shape inline → drift risk between "ingested directly" and
// "promoted later". buildVenueEntry is the one place the shape is decided.
//
// food.json keeps the full v0.2.3 shape (category / kid_friendly / anchor /
// backup_fit / name_jp_or_local + on-the-ground detail). NON-food corpora get the
// GENERIC subset only — injecting food-only fields onto a 景點/周邊 row is wrong
// data (codex #6, v0.5). The renderer (render.js venueRowHtml) reads only the
// common subset defensively, so the generic shape renders correctly everywhere.

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

// Field ORDER is kept byte-for-byte stable (existing food.json entries + the
// placement-promote tests assert it). Do not reorder.
export function buildVenueEntry(to: string, f: VenueFields): Record<string, unknown> {
  // GENERIC subset — every venue corpus reads these; non-food corpora get ONLY these.
  const generic = {
    id: f.id,
    name_zh: f.name_zh || '(unnamed)',
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
    name_jp_or_local: f.name_jp_or_local || '',
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
