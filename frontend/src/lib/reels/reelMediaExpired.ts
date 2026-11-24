/**
 * The code of social-service's `400` refusing a reel whose every refused file is the author's OWN
 * pending upload past its window (`REEL_MEDIA_EXPIRED` in `apps/social-service/src/internal/
 * reel-media.ts`, mirrored here). The file was theirs and only time took it - a create delayed past
 * the media service's pending window - so the publish queue uploads it again and re-sends; a Retry
 * re-sending the same reference would be refused for ever. Read as a CODE, never from the message.
 */
export const REEL_MEDIA_EXPIRED = 'reel_media_expired';
