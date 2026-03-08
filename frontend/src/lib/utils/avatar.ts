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
    
    // Split by spaces, dots, underscores
    const parts = cleaned.split(/[\s._-]+/).filter(Boolean);
    
    if (parts.length === 0) return cleaned[0]?.toUpperCase() || '?';
    if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
    
    // Take first letter of first two parts
    return (parts[0][0] + parts[1][0]).toUpperCase();
}
