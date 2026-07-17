// traveler-schema.ts — portable Traveler[] subset shared by scaffold + audits.
// Keep this enum single-sourced: init must never accept a band that launch-check
// later rejects (or vice versa).

export const TRAVELER_AGE_BANDS = [
  'infant', 'toddler', 'preschool', 'school', 'teen', 'adult', 'senior',
] as const;

export type TravelerAgeBand = typeof TRAVELER_AGE_BANDS[number];

export function isTravelerAgeBand(value: unknown): value is TravelerAgeBand {
  return typeof value === 'string' && (TRAVELER_AGE_BANDS as readonly string[]).includes(value);
}
