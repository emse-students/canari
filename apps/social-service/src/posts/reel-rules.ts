import { BadRequestException } from '@nestjs/common';
import { REEL_MAX_DURATION_MS } from './reel.constants';

/** What the create request says about a post's KIND, as `CreatePostDto` carries it. */
interface KindedCreateBody {
  kind?: string;
  durationMs?: number | null;
  markdown?: string;
  media?: Array<{ type?: string; mimeType?: string }>;
  images?: unknown[];
  polls?: unknown[];
  forms?: unknown[];
  attachedFormId?: string | null;
  linkedCalendarEventId?: string | null;
  scheduledAt?: string | null;
}

const present = (value: unknown): boolean =>
  Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== '';

/**
 * The shape a create request must have, decided before anything is stored or claimed.
 *
 * Every refusal is a `400`: a status is an ANSWER about the request, never retried. What the server
 * can and cannot know about a reel is on docs/wiki/services/reels.md - in short it enforces the
 * DECLARED duration and the structure, and cannot look inside the ciphertext, so it neither
 * verifies the duration nor the codec.
 *
 * A post that is not a reel keeps the text-or-media rule the DTO states (`PostBodyOrMediaConstraint`)
 * and may not carry a `durationMs`: the two fields are one fact.
 *
 * @throws BadRequestException naming what to change.
 */
export function assertCreateKindShape(body: KindedCreateBody): void {
  const isReel = body.kind === 'reel';

  if (!isReel) {
    if (present(body.durationMs)) {
      throw new BadRequestException('durationMs belongs to a reel (kind: "reel")');
    }
    return;
  }

  const duration = body.durationMs;
  if (
    typeof duration !== 'number' ||
    !Number.isInteger(duration) ||
    duration < 1 ||
    duration > REEL_MAX_DURATION_MS
  ) {
    throw new BadRequestException(
      `a reel needs an integer durationMs between 1 and ${REEL_MAX_DURATION_MS}`
    );
  }

  const media = Array.isArray(body.media) ? body.media : [];
  if (media.length !== 1 || present(body.images)) {
    throw new BadRequestException('a reel carries exactly one media (in `media`)');
  }
  const [video] = media;
  if (video.type !== 'video' || !(video.mimeType ?? '').toLowerCase().startsWith('video/')) {
    throw new BadRequestException(
      'a reel\'s media must be a video (type "video", mimeType "video/*")'
    );
  }

  for (const [field, value] of [
    ['polls', body.polls],
    ['forms', body.forms],
    ['attachedFormId', body.attachedFormId],
    ['linkedCalendarEventId', body.linkedCalendarEventId],
    ['scheduledAt', body.scheduledAt],
  ] as const) {
    if (present(value)) {
      throw new BadRequestException(`a reel cannot carry ${field}`);
    }
  }
}

/** The fields an edit may name, as `UpdatePostDto` carries them. */
interface KindedUpdateBody {
  media?: unknown[];
  images?: unknown[];
  polls?: unknown[];
  attachedFormId?: string | null;
  linkedCalendarEventId?: string | null;
  scheduledAt?: string | null;
}

/**
 * A reel's caption is the only thing an edit may change: the video, its duration and its expiry are
 * fixed at publication. Naming any other field is a `400` rather than a silent drop, so an editor
 * that believes it changed the video is told it did not.
 *
 * A field present with an EMPTY value (`polls: []`, `attachedFormId: null`) is the editor saying
 * "none", which is what a reel already has - accepted.
 */
export function assertReelEditShape(body: KindedUpdateBody): void {
  for (const [field, value] of [
    ['media', body.media],
    ['images', body.images],
    ['polls', body.polls],
    ['attachedFormId', body.attachedFormId],
    ['linkedCalendarEventId', body.linkedCalendarEventId],
    ['scheduledAt', body.scheduledAt],
  ] as const) {
    if (present(value)) {
      throw new BadRequestException(
        `a reel's caption is the only thing that can be edited (got ${field})`
      );
    }
  }
}
