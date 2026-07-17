import {
  Star,
  Heart,
  Sparkles,
  Sun,
  Moon,
  Flower2,
  Music,
  Smile,
  PartyPopper,
  Flame,
  Rocket,
  Coffee,
  type IconProps,
} from '@lucide/svelte';
import type { Component } from 'svelte';
import { m } from '$lib/paraglide/messages';

/** A lucide icon component (accepts size/color/strokeWidth), used for doodle shapes. */
type LucideIcon = Component<IconProps>;

/**
 * A placeable poster ornament. Doodles are rendered as inline lucide SVGs so they stay
 * self-contained (no external asset) and rasterise cleanly through snapdom, while honouring the
 * "lucide only" icon rule. Each entry is keyed by a stable {@link DoodleShape.key} persisted in the
 * layout; the icon component and label are resolved from that key at render time.
 */
export interface DoodleShape {
  /** Stable id stored in the layout (never localized). */
  key: string;
  /** Lucide component rendered large + recolored on the canvas and small in the palette. */
  icon: LucideIcon;
  /** Localized accessible label (function so it re-resolves on locale change). */
  label: () => string;
}

/** Curated palette of decorative shapes offered in the editor. */
export const DOODLE_SHAPES: DoodleShape[] = [
  { key: 'star', icon: Star, label: () => m.carte_doodle_star() },
  { key: 'heart', icon: Heart, label: () => m.carte_doodle_heart() },
  { key: 'sparkles', icon: Sparkles, label: () => m.carte_doodle_sparkles() },
  { key: 'sun', icon: Sun, label: () => m.carte_doodle_sun() },
  { key: 'moon', icon: Moon, label: () => m.carte_doodle_moon() },
  { key: 'flower', icon: Flower2, label: () => m.carte_doodle_flower() },
  { key: 'music', icon: Music, label: () => m.carte_doodle_music() },
  { key: 'smile', icon: Smile, label: () => m.carte_doodle_smile() },
  { key: 'party', icon: PartyPopper, label: () => m.carte_doodle_party() },
  { key: 'flame', icon: Flame, label: () => m.carte_doodle_flame() },
  { key: 'rocket', icon: Rocket, label: () => m.carte_doodle_rocket() },
  { key: 'coffee', icon: Coffee, label: () => m.carte_doodle_coffee() },
];

/** Lookup from a persisted shape key to its lucide component (Star = safe fallback). */
const BY_KEY = new Map(DOODLE_SHAPES.map((s) => [s.key, s.icon]));

/** Resolves a doodle shape key to its icon component, defaulting to the star when unknown. */
export function doodleIcon(key: string): LucideIcon {
  return BY_KEY.get(key) ?? Star;
}

/** Whether a raw string is a known doodle shape key (used when parsing persisted layouts). */
export function isDoodleShape(key: unknown): key is string {
  return typeof key === 'string' && BY_KEY.has(key);
}
