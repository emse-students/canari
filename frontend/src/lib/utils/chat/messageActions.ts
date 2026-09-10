/**
 * The quick-reaction set, in one place.
 *
 * It was declared twice - once in the desktop hover toolbar and once in the mobile action sheet -
 * with no mechanism keeping the two in step, so "the same set as mobile" was a comment rather than
 * a fact. Six is not arbitrary: the measured reference shows exactly six in its quick bar before the
 * button that opens the full picker, and a seventh would push that button off the pill.
 */
export const QUICK_REACTION_EMOJIS = ['❤️', '😂', '😮', '😢', '👍', '😡'] as const;
