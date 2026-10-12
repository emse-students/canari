import { m } from '$lib/paraglide/messages';

/** Canonical list of post reaction types with their emoji representation. */
export const REACTIONS = [
  { type: "J'aime", emoji: '❤️' },
  { type: "J'adore", emoji: '😍' },
  { type: 'Rire', emoji: '😂' },
  { type: 'Triste', emoji: '😢' },
  { type: 'Joyeux', emoji: '😊' },
  { type: 'Énervé', emoji: '😠' },
  { type: 'Canari', emoji: '🐤' },
  { type: 'Marteau', emoji: '🔨' },
] as const;

export type ReactionType = (typeof REACTIONS)[number]['type'];

/**
 * The localised name of each reaction. `type` is the STORED key (French, accented, never shown as
 * text): it is the wire value, so a label for the eye or a screen reader comes from here.
 */
const REACTION_LABELS: Record<ReactionType, () => string> = {
  "J'aime": () => m.post_reaction_name_like(),
  "J'adore": () => m.post_reaction_name_love(),
  Rire: () => m.post_reaction_name_laugh(),
  Triste: () => m.post_reaction_name_sad(),
  Joyeux: () => m.post_reaction_name_happy(),
  Énervé: () => m.post_reaction_name_angry(),
  Canari: () => m.post_reaction_name_canari(),
  Marteau: () => m.post_reaction_name_hammer(),
};

/** The user-facing name of a reaction type, localised; an unknown type is the emoji's fallback name. */
export function reactionTypeToLabel(type: string): string {
  return (REACTION_LABELS[type as ReactionType] ?? REACTION_LABELS["J'aime"])();
}

/** Returns the emoji for a reaction type. Falls back to ❤️ for unknown types. */
export function reactionTypeToEmoji(type: string): string {
  return REACTIONS.find((r) => r.type === type)?.emoji ?? '❤️';
}
