/**
 * PUBLISHING FROM THE CANAREELS CAMERA - the publish step HANDS THE TAKE TO THE PUBLISH QUEUE
 * (2026-11-24) and is done the moment it is on the device: the queue prepares it, uploads it in
 * resumable parts and creates the post under an id minted here
 * ([posts](docs/wiki/frontend/modules/posts.md#the-background-publish-queue)).
 *
 * WHY NOT ON THE SPOT ANY MORE. The step used to run the whole publish in memory - re-encode, one
 * upload, `POST /api/posts` - and a failure anywhere lost it: an Android 1.7.3 log (2026-11-24)
 * shows four attempts of one reel on a slow link, each dying ~5 s after the app was stopped (the
 * screen asleep under battery saver), the member having to start again each time. In the queue
 * the take is DURABLE (IndexedDB, before the sheet closes), the upload RESUMES from the server's
 * list of parts, and the create is IDEMPOTENT by its client id: leaving the app, a cut or a kill
 * costs at most one part, never the reel, and never a second post.
 *
 * What stays the camera's own is recorded with the take (`QueuedTakePreparation`): its cap, its
 * removed sound, its trim, the encoder lease. The rule that makes it a reel is the queue's
 * (`reelDeclarationFor` on the PREPARED frame and length, as here before). A take also sent to
 * conversations (reels-in-chat 15.5) carries the take's id: the queue's upload is the one the
 * chats adopt, before the post exists.
 */
import type { InstitutionReach } from '$lib/posts/institutionReach';
import type { MediaRef, MediaRetentionClass } from '$lib/media';
import { isAssociationIdentity, postIdentityFields } from '$lib/posts/postIdentity';
import { landingFeedFor } from '$lib/posts/landingFeed';
import type { CreatePostPayload } from '$lib/posts/api';
import type { QueuedPost } from '$lib/posts/publishQueue/publishQueueStore';
import type { ReelClip } from './reelCapture';

/**
 * The class a feed reel whose file conversations adopt is UPLOADED under. Not `reel`: an upload
 * whose post is never created would then be kept for ever. A `reel-pending` object is swept a day
 * after upload unless the post's claim promotes it to `reel`, or a chat hold keeps it (reels audit,
 * 2026-10-11; [media-service](docs/wiki/services/media-service.md)).
 */
export const FEED_REEL_UPLOAD_CLASS: MediaRetentionClass = 'reel-pending';

/** What the publish step needs from the outside world: the account, and the queue's door. */
export interface PublishReelDeps {
  /** The signed-in account, or `null` when there is none (nothing can be queued then). */
  userId: () => string | null;
  /** Writes the post and its file on the device (`enqueuePost`); rejects when it could not. */
  enqueue: (userId: string, post: QueuedPost, files: File[]) => Promise<void>;
}

/** What the publish step hands over. */
export interface PublishReelInput {
  clip: ReelClip;
  /** The caption, already trimmed; may be empty (a reel's caption is optional on the server). */
  caption: string;
  /** `''`, `ANONYMOUS_POST_IDENTITY` or an association id (`PostIdentityPicker`). */
  identity: string;
  /** "Entre étudiants" (owner, 2026-11-04): set by the step only where it is offered. */
  studentsOnly?: boolean;
  /** The reach of an institution's post (owner, 2026-11-10): set by the step only where offered. */
  reach?: InstitutionReach;
  /** The cap a VIDEO take is prepared under: `longestReelMs` of the rule, or the served cap. */
  maxDurationMs: number;
  /** The chat take of the same press (15.5), which adopts the queue's upload. */
  chatTakeId?: string;
}

/** What a published take uploaded, as the chat sends of the same take adopt it (15.5). */
export interface PublishedReelUpload {
  ref: MediaRef;
  /** The declared duration of the published reel (whole ms). */
  durationMs: number;
}

/** The account is unknown: nothing was queued. Typed, so the sheet says it without a message. */
export class ReelPublishNoAccountError extends Error {
  constructor() {
    super('no signed-in account to queue the publish for');
    this.name = 'ReelPublishNoAccountError';
  }
}

/** The file name the take is queued under, by its type. */
function takeFileName(blob: Blob): string {
  if (blob.type.startsWith('image/')) return 'camera-photo.jpg';
  return blob.type.includes('webm') ? 'canareel.webm' : 'canareel.mp4';
}

/**
 * Queues the take - a video as a CanaReel to be, a photo as an ordinary post - and resolves once it
 * and its post are ON THE DEVICE. @returns the queued post's id.
 * @throws whatever the queue's write threw (a full disk), or {@link ReelPublishNoAccountError}.
 */
export async function queueReelPublish(
  input: PublishReelInput,
  deps: PublishReelDeps
): Promise<string> {
  const { clip, caption, identity } = input;
  const isPhoto = clip.blob.type.startsWith('image/');
  const userId = deps.userId();
  if (!userId) throw new ReelPublishNoAccountError();
  const file = new File([clip.blob], takeFileName(clip.blob), {
    type: clip.blob.type || (isPhoto ? 'image/jpeg' : 'video/mp4'),
  });
  const payload: Omit<CreatePostPayload, 'media' | 'images'> = {
    markdown: caption,
    ...postIdentityFields(identity),
    ...(input.studentsOnly ? { studentsOnly: true } : {}),
    ...(input.reach ? { reach: input.reach } : {}),
  };
  const post: QueuedPost = {
    // The server stores the post under this id: a create whose answer was lost is the same post.
    id: crypto.randomUUID(),
    queuedAt: Date.now(),
    payload,
    media: [
      {
        name: file.name,
        type: file.type,
        size: file.size,
        ...(isPhoto
          ? {}
          : {
              take: {
                maxDurationMs: input.maxDurationMs,
                ...(clip.soundRemoved ? { removeAudio: true as const } : {}),
              },
            }),
      },
    ],
    landing: landingFeedFor({ asAssociation: isAssociationIdentity(identity), scheduled: false }),
    ...(input.chatTakeId && !isPhoto ? { chatTakeId: input.chatTakeId } : {}),
  };
  console.debug(
    `[reel-publish] queuing ${post.id}: ${clip.source}, ${file.type}, ${file.size} bytes` +
      (clip.soundRemoved ? ', sound removed' : '') +
      (post.chatTakeId ? `, chat take ${post.chatTakeId.slice(0, 8)}` : '')
  );
  await deps.enqueue(userId, post, [file]);
  console.debug(`[reel-publish] ${post.id} is on the device: the publish queue sends it`);
  return post.id;
}
