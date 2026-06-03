import { publicAppUrl } from '$lib/utils/publicAppUrl';

/** Copies a public Canari URL for the given SPA path to the clipboard. */
export async function copyPublicShareLink(path: string): Promise<void> {
  const url = publicAppUrl(path);
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(url);
    return;
  }
  throw new Error('Clipboard unavailable');
}
