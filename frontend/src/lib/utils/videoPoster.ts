/**
 * A transparent 1x1 GIF, as the `poster` of every video that plays by itself.
 *
 * WHY (Mi 9T, 2026-09-29, *"un logo bizarre qui s'affiche avant que la video ne charge"*): with no
 * `poster`, the Android WebView draws its OWN default one - a large grey play button - from the
 * moment the element exists until its first frame is decoded, and a feed video filling its box
 * with `object-cover` blew it up to the whole card on every return to the feed. A transparent
 * poster draws nothing, so the box's own black shows until the frame does.
 *
 * ONLY FOR A VIDEO THAT STARTS PLAYING: the spec shows the poster until playback begins, so on a
 * video that stays paused (the composer's preview) it would hide the first frame `#t=0.1` decodes.
 */
export const TRANSPARENT_VIDEO_POSTER =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
