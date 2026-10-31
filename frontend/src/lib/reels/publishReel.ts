/**
 * PUBLISHING A REEL - the CanaReels publish step's work, in the order the server's contract asks
 * for it ([reels (server)](docs/wiki/services/reels.md)): the mute check, the media token, the
 * on-device re-encode to ONE fragmented MP4 (`prepareVideoForUpload`, C3), the upload under the
 * `reel-pending` retention class ({@link FEED_REEL_UPLOAD_CLASS}), then `POST /api/posts` with
 * `kind: 'reel'` and the declared duration - whose claim promotes the blob to `reel`.
 *
 * Every dependency is a parameter so the order and the payload are pinned by a test with no network
 * and no encoder (`publishReel.test.ts`); the screen passes {@link defaultPublishReelDeps}.
 *
 * A failure is thrown as a {@link ReelPublishError} carrying the STAGE it reached and the original
 * error as its cause - typed at the throw, so the screen names where it stopped without reading a
 * message (`publishFailureMessage` reads the cause).
 */
import {
  MediaService,
  preparePostMedia,
  type ImageDimensions,
  type MediaRef,
  type MediaRetentionClass,
} from '$lib/media';
import { createPost, type CreatePostPayload, type PostEntity } from '$lib/posts/api';
import { assertNotMuted } from '$lib/moderation/muteCheck';
import type { PublishStage } from '$lib/posts/publishFailure';
import { postIdentityFields } from '$lib/posts/postIdentity';
import { getToken } from '$lib/stores/auth';
import {
  prepareVideoForUpload,
  type PrepareVideoOptions,
  type PreparedVideo,
} from '$lib/video/prepareVideoForUpload';
import type { ReelClip } from './reelCapture';
import { firstFramePlaceholder } from './reelFirstFrame';

/** What the publish step needs from the outside world. */
export interface PublishReelDeps {
  assertNotMuted: () => Promise<void>;
  getToken: () => Promise<string>;
  uploadLimits: () => Promise<{ maxPlaintextBytes: number } | null>;
  prepare: (source: Blob, options: PrepareVideoOptions) => Promise<PreparedVideo>;
  upload: (file: File, token: string, dims: ImageDimensions) => Promise<MediaRef>;
  /**
   * The ThumbHash of the prepared file's FIRST FRAME (`MediaRef.placeholder`), or `null`: every
   * reader paints it while the reel loads, since the server makes no thumbnail. Never throws.
   */
  placeholder: (file: File) => Promise<string | null>;
  createPost: (payload: CreatePostPayload) => Promise<PostEntity>;
}

/**
 * The class a feed reel is UPLOADED under. Not `reel`: an upload whose post is never created (a
 * failed `createPost`, a kill or a cancel between the two calls) would then be kept for ever. A
 * `reel-pending` object is swept a day after upload unless the post's claim promotes it to `reel`
 * (reels audit, 2026-10-11; [media-service](docs/wiki/services/media-service.md)).
 */
export const FEED_REEL_UPLOAD_CLASS: MediaRetentionClass = 'reel-pending';

/** The production dependencies: the real services, the {@link FEED_REEL_UPLOAD_CLASS} upload class. */
export function defaultPublishReelDeps(): PublishReelDeps {
  const media = new MediaService();
  return {
    assertNotMuted,
    getToken,
    uploadLimits: () => media.uploadLimits(),
    prepare: prepareVideoForUpload,
    upload: (file, token, dims) =>
      media.encryptAndUpload(file, token, dims, FEED_REEL_UPLOAD_CLASS),
    placeholder: firstFramePlaceholder,
    createPost,
  };
}

/** Dependencies for publishing a camera photo as a normal archive post. */
export interface PublishPhotoDeps {
  assertNotMuted: () => Promise<void>;
  getToken: () => Promise<string>;
  upload: (file: File, token: string, dims: ImageDimensions) => Promise<MediaRef>;
  createPost: (payload: CreatePostPayload) => Promise<PostEntity>;
}

/** The production services for a camera photo, whose media is retained with ordinary posts. */
export function defaultPublishPhotoDeps(): PublishPhotoDeps {
  const media = new MediaService();
  return {
    assertNotMuted,
    getToken,
    upload: (file, token, dims) => media.encryptAndUpload(file, token, dims, 'archive'),
    createPost,
  };
}

export interface PublishReelInput {
  clip: ReelClip;
  /** The caption, already trimmed; may be empty (a reel's caption is optional on the server). */
  caption: string;
  /** `''`, `ANONYMOUS_POST_IDENTITY` or an association id (`PostIdentityPicker`). */
  identity: string;
  /** The server's cap (`GET /api/posts/reel-limits`). */
  maxDurationMs: number;
  /** Progress and cancel for the re-encode (`VideoPreparationState.optionsFor`). */
  video: Pick<PrepareVideoOptions, 'onProgress' | 'signal'>;
  /** Told each step as it starts, so the screen can name it. */
  onStage?: (stage: PublishStage) => void;
}

/** Input for publishing a camera photo without pretending it is a time-based reel. */
export interface PublishPhotoInput {
  clip: ReelClip;
  caption: string;
  identity: string;
  onStage?: (stage: PublishStage) => void;
}

/** A publish that stopped, and where. The cause is whatever the step threw. */
export class ReelPublishError extends Error {
  constructor(
    readonly stage: PublishStage,
    options: { cause: unknown }
  ) {
    super(`reel publish failed at ${stage}`, options);
    this.name = 'ReelPublishError';
  }
}

/**
 * The duration the reel DECLARES, in whole milliseconds and within `[1, maxDurationMs]`.
 *
 * The upper clamp is not a correction of a long video: `prepareVideoForUpload` already refused
 * anything past the cap's half-second grace (`VIDEO_DURATION_GRACE_SECONDS`), which exists because a
 * recorder told to stop at 90 s writes a container ending a few hundredths later. That clip IS a
 * 90-second reel, and the server refuses a declaration over the cap, so it declares the cap.
 */
export function declaredReelDurationMs(durationSeconds: number, maxDurationMs: number): number {
  const ms = Math.round(durationSeconds * 1000);
  if (ms > maxDurationMs) {
    console.debug(`[reel-publish] ${ms} ms is within the grace; declared as ${maxDurationMs}`);
  }
  return Math.min(maxDurationMs, Math.max(1, ms));
}

/** Publishes one reel; resolves with the created post. @throws {ReelPublishError} */
export async function publishReel(
  input: PublishReelInput,
  deps: PublishReelDeps = defaultPublishReelDeps()
): Promise<PostEntity> {
  const { clip, caption, identity, maxDurationMs, video, onStage } = input;
  console.debug(
    `[reel-publish] start: ${clip.source}, ${clip.blob.type || 'typeless'}, ${clip.blob.size} bytes` +
      (clip.soundRemoved ? ', sound removed' : '')
  );
  let stage: PublishStage = 'moderation';
  const enter = (next: PublishStage) => {
    stage = next;
    onStage?.(next);
  };
  try {
    enter('moderation');
    await deps.assertNotMuted();

    enter('mediaToken');
    const token = await deps.getToken();
    const limits = await deps.uploadLimits();

    enter('mediaPrepare');
    const prepared = await deps.prepare(clip.blob, {
      maxSeconds: maxDurationMs / 1000,
      maxBytes: limits?.maxPlaintextBytes,
      // The member's "remove the sound": the published file carries no audio track at all.
      removeAudio: clip.soundRemoved === true,
      // A reel loops: sound outside the picture would be a still frame on every pass.
      trimToVideo: true,
      ...video,
    });

    // Decoded from the very file uploaded, so the blur is of the frame every reader will see first.
    const placeholder = await deps.placeholder(prepared.file);
    if (!placeholder) console.warn('[reel-publish] published without a first-frame placeholder');

    enter('mediaUpload');
    const uploaded = await deps.upload(prepared.file, token, {
      width: prepared.width,
      height: prepared.height,
    });
    const ref: MediaRef = placeholder ? { ...uploaded, placeholder } : uploaded;

    enter('createPost');
    const post = await deps.createPost({
      kind: 'reel',
      durationMs: declaredReelDurationMs(prepared.durationSeconds, maxDurationMs),
      markdown: caption,
      media: [ref],
      ...postIdentityFields(identity),
    });
    console.debug(`[reel-publish] published ${post.id}`);
    return post;
  } catch (err) {
    throw new ReelPublishError(stage, { cause: err });
  }
}

/** Publishes an edited camera photo as a normal archive post. @throws {ReelPublishError} */
export async function publishCameraPhoto(
  input: PublishPhotoInput,
  deps: PublishPhotoDeps = defaultPublishPhotoDeps()
): Promise<PostEntity> {
  const { clip, caption, identity, onStage } = input;
  let stage: PublishStage = 'moderation';
  const enter = (next: PublishStage) => {
    stage = next;
    onStage?.(next);
  };
  try {
    enter('moderation');
    await deps.assertNotMuted();
    enter('mediaToken');
    const token = await deps.getToken();
    enter('mediaPrepare');
    const prepared = await preparePostMedia(
      new File([clip.blob], 'camera-photo.jpg', { type: clip.blob.type || 'image/jpeg' })
    );
    if (!prepared.dims) throw new Error('camera photo has no dimensions');
    enter('mediaUpload');
    const ref = await deps.upload(prepared.file, token, prepared.dims);
    enter('createPost');
    return await deps.createPost({
      markdown: caption,
      media: [ref],
      ...postIdentityFields(identity),
    });
  } catch (err) {
    throw new ReelPublishError(stage, { cause: err });
  }
}
