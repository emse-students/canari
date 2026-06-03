/**
 * Strips lightweight Markdown to plain text for meta descriptions.
 */
export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#*_~>|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Truncates text for meta description length. */
export function truncateForMeta(text: string, max = 160): string {
  const plain = text.trim();
  if (plain.length <= max) return plain;
  return `${plain.slice(0, max - 1).trim()}…`;
}
