import { resolveMediaType } from '$lib/utils/mediaLayout';

/**
 * SEVERAL DOCUMENTS ARE A LIST OF ROWS, ONE IS A CARD (owner, 2026-11-02): each file carried its own
 * first-page preview, so a post of five PDFs was a column of five pages. From two FILES on, every
 * file is a compact row - icon, name, size, download - with no preview and no download until it is
 * tapped. Audio is not a file here and keeps its player.
 *
 * The ONE rule, read by the post card (`PostContent`) and by the editor's strip of existing
 * attachments (`EditPostForm`), so the two cannot disagree.
 *
 * @param media A post's attachments, in order.
 */
export function usesCompactDocumentRows(media: readonly Parameters<typeof resolveMediaType>[0][]) {
  return media.filter((item) => resolveMediaType(item) === 'file').length >= 2;
}
