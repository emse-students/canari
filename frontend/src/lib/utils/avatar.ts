/**
 * avatar.ts - Avatar utilities
 * Generate colors and initials for user avatars
 */

/**
 * Generate a deterministic color from a string (userId)
 */
export function generateAvatarColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
    hash = hash & hash; // Convert to 32bit integer
  }

  // Generate pleasing HSL color
  const hue = Math.abs(hash % 360);
  const saturation = 65 + (Math.abs(hash) % 20); // 65-85%
  const lightness = 45 + (Math.abs(hash >> 8) % 15); // 45-60%

  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

/** How many gradient hues the placeholder palette has (`--avatar-hue-N-from/to` in `app.css`). */
export const AVATAR_HUE_COUNT = 8;

/**
 * Which palette hue (0..AVATAR_HUE_COUNT-1) an entity's placeholder wears.
 *
 * THE SEED IS AN ID AND NEVER A NAME: a user id, a conversation or group id, an association id. A
 * display name is editable, so hashing it would recolour a person the day they rename themselves,
 * and the same person must read as the same colour in the chat list, the profile, the member list
 * and a notification. FNV-1a: it spreads evenly over the low bits and is a pure function of the
 * characters - no clock, no per-device state, so two devices always agree.
 */
export function avatarHueIndex(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % AVATAR_HUE_COUNT;
}

/**
 * The first N CHARACTERS of a string, never the first N code units.
 *
 * `s[0]` and `substring(0, 2)` both count UTF-16 code units, so on anything outside the Basic
 * Multilingual Plane they return half of a surrogate pair - not a character, and drawn as a
 * placeholder box. The letters this file keeps are `\p{L}` and `\p{N}`, which include astral ones
 * (mathematical alphanumerics, CJK extensions), so the hazard is inside the filtered string too and
 * not only in the raw name.
 */
function firstChars(value: string, count: number): string {
  return [...value].slice(0, count).join('');
}

/**
 * Get initials from a username/userId
 */
export function getInitials(name: string): string {
  if (!name) return '?';

  // Remove @ if present (for @user format)
  const cleaned = name.replace(/^@/, '');

  // Keep only letters/digits so generated SVG is always valid.
  const alnumParts = cleaned
    .split(/[\s._-]+/)
    .map((part) => part.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);

  if (alnumParts.length === 0) {
    const compact = cleaned.replace(/[^\p{L}\p{N}]/gu, '');
    return firstChars(compact, 2).toUpperCase() || '?';
  }

  if (alnumParts.length === 1) return firstChars(alnumParts[0], 2).toUpperCase();

  // Take first letter of first two valid parts.
  return (firstChars(alnumParts[0], 1) + firstChars(alnumParts[1], 1)).toUpperCase();
}
