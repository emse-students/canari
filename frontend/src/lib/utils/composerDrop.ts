import { showToast } from '$lib/stores/toast.svelte';
import { m } from '$lib/paraglide/messages';
import { Log } from '$lib/utils/Log';
import {
  carriesUninsertableMarkup,
  fetchWebImageFile,
  filesFromTransfer,
  localFileAddressesFromTransfer,
  webImageUrlsFromTransfer,
  WebImageFetchError,
} from '$lib/utils/composerTransfer';

/** What a composer does with the parts of a drop. */
export interface ComposerDropHandlers {
  /** Receives every file the drop produced: real files, or web images fetched from their address. */
  onFiles?: (files: File[]) => void;
  /** Receives the dropped `text/plain`, for a composer with a text body; absent = text is ignored. */
  onText?: (text: string) => void;
}

/**
 * THE ONE DROP RULE of every composer (chat panel, chat editor, post sheet): a drop is read in a
 * fixed order and each shape ends in an attachment, a text, or a sentence - never in silence.
 *
 * 1. real files (`files` / `items`) -> `onFiles`;
 * 2. a local file's ADDRESS the file manager withheld (Firefox + Nemo) -> refusal toast, nothing inserted;
 * 3. an image dragged from a web page (an address, no bytes) -> fetched and handed to `onFiles` when
 *    the host allows it, else a toast saying so (the refusal is logged with its host and cause);
 * 4. plain text -> `onText`.
 *
 * The transfer is read synchronously, before any `await`: a `DataTransfer` is emptied once the
 * event handler returns.
 */
export function handleComposerDrop(
  dt: DataTransfer | null | undefined,
  { onFiles, onText }: ComposerDropHandlers
): void {
  const files = filesFromTransfer(dt);
  if (files.length > 0) {
    if (!onFiles) {
      Log.d('COMPOSER', `drop carried ${files.length} file(s); this composer takes none`);
      return;
    }
    onFiles(files);
    return;
  }

  const refused = localFileAddressesFromTransfer(dt);
  if (refused.length > 0) {
    console.warn(
      `[COMPOSER] drop announced ${refused.length} local file(s) but handed over none - the file manager did not give the browser the file`
    );
    showToast(m.composer_drop_file_unreadable());
    return;
  }

  const urls = onFiles ? webImageUrlsFromTransfer(dt) : [];
  if (urls.length > 0) {
    void attachWebImages(urls, onFiles!);
    return;
  }

  const text = dt?.getData('text/plain') ?? '';
  if (text && onText) {
    onText(text);
    return;
  }
  if (carriesUninsertableMarkup(dt)) {
    Log.d('COMPOSER', 'drop carried markup with no file and no text - nothing inserted');
  }
}

/** Fetches each address; whatever arrives is attached, whatever does not is said out loud. */
async function attachWebImages(urls: string[], onFiles: (files: File[]) => void): Promise<void> {
  Log.d('COMPOSER', `drop carried ${urls.length} web image address(es), no file - fetching`);
  const results = await Promise.allSettled(urls.map((url) => fetchWebImageFile(url)));
  const files: File[] = [];
  let failed = 0;
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      files.push(result.value);
      return;
    }
    failed++;
    const reason = result.reason instanceof WebImageFetchError ? result.reason.reason : 'unknown';
    // The host tells the causes apart; the query string may carry a token, so it is not logged.
    let host = 'unparsable address';
    try {
      host = new URL(urls[i]).host;
    } catch {
      // keep the placeholder
    }
    console.warn(`[COMPOSER] dropped web image from ${host} not attached (${reason})`);
  });
  if (files.length > 0) onFiles(files);
  if (failed > 0) showToast(m.composer_drop_web_image_refused());
}
