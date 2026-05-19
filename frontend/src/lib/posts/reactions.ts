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

/** Returns the emoji for a reaction type. Falls back to ❤️ for unknown types. */
export function reactionTypeToEmoji(type: string): string {
  return REACTIONS.find((r) => r.type === type)?.emoji ?? '❤️';
}
