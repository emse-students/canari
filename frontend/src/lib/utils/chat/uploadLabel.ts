import { m } from '$lib/paraglide/messages';
import { formatFileSize } from '$lib/utils/fileSize';
import { uploadPercent, type UploadView } from '$lib/utils/chat/uploadProgress.svelte';

/**
 * The one line an attachment's bubble says about its upload, localized. Every figure is a REAL byte
 * count of the encrypted body (a few bytes over the file's own size), never an estimate, and a
 * state with no honest figure says what it is waiting for instead of showing a percentage.
 *
 * @param view         What the outbox knows right now.
 * @param declaredSize The attachment's own size, shown until the first progress event gives the
 *                     encrypted body's.
 */
export function uploadCaption(view: UploadView, declaredSize: number): string {
  const total = formatFileSize(view.total > 0 ? view.total : declaredSize);
  switch (view.phase) {
    case 'preparing':
      return m.upload_preparing();
    case 'waiting':
      return m.upload_waiting();
    case 'blocked':
      return m.upload_blocked();
    case 'stalled':
      return m.upload_stalled({ sent: formatFileSize(view.loaded), total });
    case 'uploading': {
      const percent = uploadPercent(view);
      return percent === null
        ? m.upload_sending({ total })
        : m.upload_progress({ percent: String(percent), sent: formatFileSize(view.loaded), total });
    }
  }
}
