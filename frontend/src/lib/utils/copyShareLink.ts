import { copyText, type CopyResult } from '$lib/utils/clipboard';
import { publicAppUrl } from '$lib/utils/publicAppUrl';

/**
 * Copies a public Canari URL for the given SPA path, with the helper's confirmation toast.
 * The public origin is what the link needs here; the write and its feedback are {@link copyText}.
 */
export function copyPublicShareLink(path: string): Promise<CopyResult> {
  return copyText(publicAppUrl(path), { what: 'link' });
}
