/**
 * The response headers a cross-origin client of this service reads, beyond the safelisted ones
 * (`corsOptions`' `exposedHeaders`). A header left out reads as `null` on the phone apps, whose
 * WebView origin is not the API's, with no error anywhere.
 *
 * `Content-Range`: a reel's whole read joins the head fetched ahead and asks for the rest only
 * (`frontend/src/lib/utils/mediaHeadStore.ts`, `readAfterHead`). It joins a `206` to the head only
 * when the range starts where the head ends, and reads the whole file otherwise - so without this
 * header every such read on a phone would fetch the file twice.
 */
export const MEDIA_EXPOSED_HEADERS: string[] = ['Content-Range'];
