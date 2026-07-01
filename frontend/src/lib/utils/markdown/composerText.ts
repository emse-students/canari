/**
 * Trims leading and trailing whitespace (spaces, tabs, newlines) from composer markdown
 * before blur commit or persistence. Internal line breaks are preserved.
 */
export function trimComposerText(text: string): string {
  return text.trim();
}

/**
 * Returns trimmed text and whether the value changed.
 */
export function trimComposerTextIfNeeded(text: string): { text: string; changed: boolean } {
  const trimmed = trimComposerText(text);
  return { text: trimmed, changed: trimmed !== text };
}
