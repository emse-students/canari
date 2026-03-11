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
    return compact.substring(0, 2).toUpperCase() || '?';
  }

  if (alnumParts.length === 1) return alnumParts[0].substring(0, 2).toUpperCase();

  // Take first letter of first two valid parts.
  return (alnumParts[0][0] + alnumParts[1][0]).toUpperCase();
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Generate a deterministic SVG avatar placeholder as data URI.
 */
export function generateAvatarPlaceholder(name: string): string {
  const initials = getInitials(name);
  const safeInitials = escapeXml(initials);
  const base = generateAvatarColor(name);
  const accent = generateAvatarColor(`${name}-accent`);

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-label="Avatar ${safeInitials}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${base}" />
      <stop offset="100%" stop-color="${accent}" />
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#g)" />
  <circle cx="102" cy="26" r="14" fill="rgba(255,255,255,0.18)" />
  <text x="64" y="72" text-anchor="middle" dominant-baseline="middle" fill="white" font-family="Segoe UI, Inter, sans-serif" font-size="44" font-weight="700">${safeInitials}</text>
</svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
