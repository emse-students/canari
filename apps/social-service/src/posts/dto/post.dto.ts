import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Matches,
  MaxLength,
  Min,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { COMMENT_MAX_LENGTH, COMMENT_PAGE_MAX, type CommentOrder } from '../comment-page';
import { LIST_POST_FEEDS, type ListPostsFeed } from '../list-feed';
import { FOR_YOU_AS_OF_PATTERN } from '../for-you-feed';

/**
 * A post needs a body OR a media entry - the rule the composer's Publier button already applies
 * (`hasContent` in `frontend/src/lib/posts/composerReadiness.ts`, the client's one spelling).
 *
 * The body was `@IsNotEmpty()` alone, so a photo or a video posted without a caption - which the
 * composer enables and which a reel is by default - went through the whole publish (preparation,
 * encryption, upload) and was then refused here with a 400, the uploaded blob left behind. Found on
 * the Mi 9T on 2026-10-02 (`markdown should not be empty`). Whitespace counts as empty, as it does
 * on the client.
 */
@ValidatorConstraint({ name: 'postBodyOrMedia', async: false })
export class PostBodyOrMediaConstraint implements ValidatorConstraintInterface {
  validate(markdown: unknown, args: ValidationArguments): boolean {
    if (typeof markdown === 'string' && markdown.trim().length > 0) return true;
    const post = args.object as { media?: unknown[]; images?: unknown[] };
    return (post.media?.length ?? 0) + (post.images?.length ?? 0) > 0;
  }

  defaultMessage(): string {
    return 'markdown should not be empty unless the post carries media';
  }
}

/** A ThumbHash is at most a few dozen bytes; its base64 never approaches this. */
export const MEDIA_PLACEHOLDER_MAX_LENGTH = 128;

export class PostMediaDto {
  @IsString()
  @IsNotEmpty()
  @IsIn(['image', 'video', 'audio', 'file'])
  type: string;

  @IsString()
  @IsNotEmpty()
  mediaId: string;

  @IsString()
  @IsNotEmpty()
  key: string;

  @IsString()
  @IsNotEmpty()
  iv: string;

  @IsString()
  @IsNotEmpty()
  mimeType: string;

  @IsNumber()
  @Min(0)
  size: number;

  @IsString()
  @IsOptional()
  fileName?: string;

  @IsInt()
  @IsOptional()
  @Min(1)
  width?: number;

  @IsInt()
  @IsOptional()
  @Min(1)
  height?: number;

  /**
   * How the blob is sealed (CanaReels R2, `frontend/src/lib/mediaSegmented.ts`): absent for the
   * single AES-GCM block every post was written with until then, `'segmented-v1'` for the STREAM
   * format a video can be played from while it downloads.
   *
   * DECLARED HERE IN THE READER RELEASE, BEFORE ANY CLIENT WRITES IT: `whitelist: true` deletes an
   * undeclared field, and a segmented blob stored without its encoding would be read by every
   * client as a single block and refused - the post's video lost, silently, at the first save.
   * A value outside the list is a 400, never stored: the server cannot read the bytes either way,
   * but it can refuse to record a format no client knows.
   */
  @IsString()
  @IsOptional()
  @IsIn(['segmented-v1'])
  encoding?: string;

  /**
   * A ThumbHash of the medium's picture - a video's FIRST FRAME - as base64, made by the PUBLISHER
   * (`frontend/src/lib/utils/mediaPlaceholder.ts`): the server transcodes nothing and draws no
   * thumbnail (CanaReels C3), so this ~25-byte blur is the only picture a reel has before its
   * bytes arrive. The reel viewer paints it from the first frame of the page instead of a play
   * glyph. Declared so `whitelist: true` keeps it; bounded, since a ThumbHash is a few dozen bytes
   * and anything longer is not one.
   */
  @IsString()
  @IsOptional()
  @MaxLength(MEDIA_PLACEHOLDER_MAX_LENGTH)
  @Matches(/^[A-Za-z0-9+/]*={0,2}$/, { message: 'placeholder must be base64' })
  placeholder?: string;
}

export class PollOptionInputDto {
  /**
   * The option's existing id, when a poll is being EDITED.
   *
   * It was not here, and `whitelist: true` therefore deleted it from every payload: each save
   * minted new ids, no stored vote matched an option any more, and fixing a typo in a question
   * emptied the poll. An option the editor did not touch keeps its id, and with it its votes.
   */
  @IsString()
  @IsOptional()
  id?: string;

  @IsString()
  @IsNotEmpty()
  label: string;
}

export class PollInputDto {
  @IsString()
  @IsOptional()
  id?: string;

  @IsString()
  @IsNotEmpty()
  question: string;

  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => PollOptionInputDto)
  options: PollOptionInputDto[];

  @IsBoolean()
  @IsOptional()
  multipleChoice?: boolean;

  /**
   * How many options one voter may pick, or absent/null for no limit.
   *
   * `@IsOptional()` passes `null` through untouched, which is how the composer CLEARS a cap: an
   * omitted field and an explicit `null` must mean the same thing here, because the update path
   * rebuilds the poll from this payload alone.
   */
  @IsInt()
  @Min(2)
  @IsOptional()
  maxSelections?: number | null;

  @IsDateString()
  @IsOptional()
  endsAt?: string;

  /**
   * Store votes without their voter: a tally and a list of who voted, never joined. FIXED at
   * creation - the stored value wins on an edit - and final for the voter (see `anonymous-poll.ts`).
   */
  @IsBoolean()
  @IsOptional()
  anonymous?: boolean;
}

export class FormOptionInputDto {
  @IsString()
  @IsOptional()
  id?: string;

  @IsString()
  @IsNotEmpty()
  label: string;

  @IsNumber()
  priceModifier: number;
}

export class FormItemInputDto {
  @IsString()
  @IsOptional()
  id?: string;

  @IsString()
  @IsNotEmpty()
  label: string;

  @IsBoolean()
  required: boolean;

  @IsString()
  @IsNotEmpty()
  type: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FormOptionInputDto)
  @IsOptional()
  options?: FormOptionInputDto[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  rows?: string[];

  @IsOptional()
  scale?: {
    min: number;
    max: number;
    minLabel?: string;
    maxLabel?: string;
  };
}

export class FormInputDto {
  @IsString()
  @IsOptional()
  id?: string;

  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsNotEmpty()
  eventId: string;

  @IsNumber()
  @Min(0)
  basePrice: number;

  @IsString()
  currency: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FormItemInputDto)
  items: FormItemInputDto[];
}

/**
 * The publish queue's withdrawal of a post it queued (`POST /posts/:id/withdraw`): the media it
 * uploaded for it, which social-service deletes unless a live row cites them.
 */
export class WithdrawPostDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  mediaIds?: string[];
}

export class CreatePostDto {
  /**
   * The post's id, minted by the CLIENT when it queued the post, so a resend after a lost answer
   * is answered from the row the first request wrote instead of making a second post
   * (`post-client-id.ts`). A random v4 UUID only (the nil UUID and other versions are refused): its
   * unguessability is what makes the 409 for another author's id harmless. Optional: without it
   * the database generates the id, as before.
   */
  @IsUUID('4')
  @IsOptional()
  id?: string;

  @IsString()
  @IsOptional()
  authorId?: string;

  /**
   * `'reel'` publishes a CanaReel (one video, expires after a month); absent or `'post'` is the
   * post that has always existed. The rest of the reel's shape is `assertCreateKindShape`.
   */
  @IsIn(['post', 'reel'])
  @IsOptional()
  kind?: 'post' | 'reel';

  /** The reel's length in ms as the CLIENT declares it; refused above `REEL_MAX_DURATION_MS`. */
  @IsInt()
  @IsOptional()
  durationMs?: number;

  /** Text or media (a reel always carries its video, so its caption may be empty). */
  @IsString()
  @Validate(PostBodyOrMediaConstraint)
  @MaxLength(50_000)
  markdown: string;

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => PostMediaDto)
  media?: PostMediaDto[];

  /** @deprecated Use `media` instead. Kept for backward-compatibility with older clients. */
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => PostMediaDto)
  images?: PostMediaDto[];

  @IsString()
  @IsOptional()
  attachedFormId?: string;

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => PollInputDto)
  polls?: PollInputDto[];

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => FormInputDto)
  forms?: FormInputDto[];

  @IsString()
  @IsOptional()
  associationId?: string;

  /**
   * Server decides precedence when both are set: `PostsController.createPost` forces this false
   * whenever `associationId` is present, never trusting the client to have respected the
   * mutual exclusivity the composer's own UI already enforces.
   */
  @IsBoolean()
  @IsOptional()
  anonymous?: boolean;

  /**
   * "Entre étudiants" (owner, 2026-11-04): read only by students and the association's members.
   * Absent is OFF. Refused, typed, on a post that is not an association's or a list's
   * (`assertStudentsOnlyOffered`).
   */
  @IsBoolean()
  @IsOptional()
  studentsOnly?: boolean;

  @IsOptional()
  @ValidateIf((_, v) => typeof v === 'string' && v.length > 0)
  @IsUUID()
  linkedCalendarEventId?: string;

  @IsDateString()
  @IsOptional()
  scheduledAt?: string;
}

export class ListPostsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  offset?: number;

  /** Default `all` when omitted; `reels` is the CanaReels viewer's list, not a tab (`list-feed.ts`). */
  @IsOptional()
  @IsIn([...LIST_POST_FEEDS])
  feed?: ListPostsFeed;

  /**
   * Restricts the page to one kind. ABSENT MEANS BOTH - the feed shows reels where it shows posts
   * - and the full-screen reel viewer asks for `reel`.
   */
  @IsOptional()
  @IsIn(['post', 'reel'])
  kind?: 'post' | 'reel';

  /**
   * With `kind=reel`: the posts whose only content is ONE picture come too - the CanaReels list
   * (user, 2026-10-19: photos in CanaReels, as on Instagram). Ignored without `kind=reel`. A query
   * string carries text, so only the literal `true` turns it on.
   */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  singlePhotos?: boolean;

  /**
   * With `kind=reel`: the posts whose only content is ONE picture OR ONE video come too (owner,
   * 2026-11-06: a feed video not filmed with the Canari camera is in CanaReels as a picture is).
   * Wins over `singlePhotos`, which stays for an installed client that asks for pictures alone.
   * Ignored without `kind=reel`.
   */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  singleMedia?: boolean;

  /**
   * With `kind=reel`: the posts of TWO TO TEN pictures and videos and nothing else come too, as
   * well as the single ones (owner, 2026-11-06: a carousel, swiped left and right as on
   * Instagram). Wins over `singleMedia` and `singlePhotos`, which keep their meaning for an
   * installed client that cannot draw a carousel. Ignored without `kind=reel`.
   */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  multiMedia?: boolean;

  /**
   * With `multiMedia`: a post with a LINK in its text comes too, the client drawing the link in the
   * caption (owner, 2026-11-06). Ignored without `multiMedia`, so an installed client that sends an
   * older switch keeps the rule it was built for.
   */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  withLinks?: boolean;

  /**
   * A LIVE REPLAY (`kind = 'replay'`, docs/wiki/live-replays.md) comes in this page only when the
   * client says it can draw one - the `withLinks` precedent: a build that cannot draw a replay never
   * receives one. With `kind=reel` it joins the CanaReels list; without `kind`, the feed.
   */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  withReplays?: boolean;

  /**
   * `feed=reels` only: the CanaReels viewer RANKED like Pour toi (owner, 2026-11-10, `for-you-feed.ts`)
   * rather than newest first. Sent by the 1.6.9 client; an installed one does not, and keeps the
   * order it pages by offset (docs/wiki/legacy-compatibility.md).
   */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  ranked?: boolean;

  /**
   * A ranked list only (`feed=foryou`, `feed=reels&ranked=true`): the `feedAsOf` its first page served, so a later page is a slice
   * of THAT ranking (`for-you-feed.ts`). Exactly the served spelling: it names a stored snapshot.
   */
  @IsOptional()
  @Matches(FOR_YOU_AS_OF_PATTERN)
  asOf?: string;

  /** Custom feed: filter by author promotion (personal posts only). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  promo?: number;

  /** Custom feed: filter by author formation (personal posts only), substring match. */
  @IsOptional()
  @IsString()
  formation?: string;
}

/** Query of `GET :postId/comments`: one page of whole threads. See `pageComments`. */
export class ListCommentsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  cursor?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(COMMENT_PAGE_MAX)
  limit?: number;

  @IsOptional()
  @IsIn(['recent', 'oldest'])
  order?: CommentOrder;
}

export class VotePollDto {
  @IsString()
  @IsOptional()
  userId?: string;

  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  optionIds: string[];
}

/** The most a comment's picture may weigh, sealed: the media service's own ceiling is higher, a comment's is not. */
export const COMMENT_MEDIA_MAX_BYTES = 16 * 1024 * 1024;

/**
 * THE ONE PICTURE (or GIF) A COMMENT CARRIES, validated field by field.
 *
 * It was `@IsObject()` alone, so a crafted request could store any shape - a video or a `file`
 * entry, a 4 GB `size`, an `iv` of a megabyte - in a row every reader of the post then renders. The
 * client's `CommentComposer` strips `type` from the ref it stages, so `type` is optional here but,
 * when sent, must say `image`; the `mimeType` must be an image either way. `encoding` is not
 * declared, so `whitelist` drops it: a comment's picture is one AES-GCM block, never the segmented video format.
 *
 * The uploader is checked at the write by `assertOwnMedia`; the blob's owner is recorded by the media
 * service, which deletes only an object its recorded uploader names (`commentMediaOwners`).
 */
export class CommentMediaDto {
  @IsOptional()
  @IsString()
  @IsIn(['image'])
  type?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  mediaId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  key: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  iv: string;

  @IsString()
  @Matches(/^image\/[a-z0-9.+-]{1,40}$/i, { message: 'mimeType must be an image type' })
  mimeType: string;

  @IsNumber()
  @Min(1)
  @Max(COMMENT_MEDIA_MAX_BYTES)
  size: number;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  fileName?: string;

  @IsInt()
  @IsOptional()
  @Min(1)
  @Max(20000)
  width?: number;

  @IsInt()
  @IsOptional()
  @Min(1)
  @Max(20000)
  height?: number;

  /** The publisher's ThumbHash, as a post's media carries it (see {@link PostMediaDto.placeholder}). */
  @IsString()
  @IsOptional()
  @MaxLength(MEDIA_PLACEHOLDER_MAX_LENGTH)
  @Matches(/^[A-Za-z0-9+/]*={0,2}$/, { message: 'placeholder must be base64' })
  placeholder?: string;
}

export class AddCommentDto {
  @IsString()
  @IsOptional()
  userId?: string;

  @IsString()
  @IsOptional()
  @MaxLength(COMMENT_MAX_LENGTH)
  text?: string;

  @IsString()
  @IsOptional()
  parentId?: string;

  /**
   * Comment AS this association: needs `POST_AS_ASSO` there (the controller asks `canPostAs`).
   * Exclusive with `anonymous` - an association comment wins, like a post's.
   */
  @IsOptional()
  @IsUUID()
  associationId?: string;

  /** Comment anonymously: open to any member, the account stays known to moderation. */
  @IsOptional()
  @IsBoolean()
  anonymous?: boolean;

  /** The comment's ONE picture or GIF. See {@link CommentMediaDto}. */
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => CommentMediaDto)
  media?: CommentMediaDto;
}

export class AddReactionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  reactionType: string; // e.g. like, love, sad, laugh, angry, canari, hammer
}

export class EditCommentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(COMMENT_MAX_LENGTH)
  text: string;
}

export class UpdatePostDto {
  /** Text or media, as on create; a reel's caption can only be emptied in a request that still names its media. */
  @IsString()
  @Validate(PostBodyOrMediaConstraint)
  @MaxLength(50_000)
  markdown: string;

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => PostMediaDto)
  media?: PostMediaDto[];

  /** @deprecated Use `media` instead. Kept for backward-compatibility with older clients. */
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => PostMediaDto)
  images?: PostMediaDto[];

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => PollInputDto)
  polls?: PollInputDto[];

  @IsOptional()
  @ValidateIf((_, v) => v != null && v !== '')
  @IsUUID()
  attachedFormId?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => typeof v === 'string' && v.length > 0)
  @IsUUID()
  linkedCalendarEventId?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v != null && v !== '')
  @IsDateString()
  scheduledAt?: string | null;

  /**
   * "Entre étudiants", changed after publication, both ways (owner, 2026-11-04, decision 5). Absent
   * leaves the stored value alone - a client older than the switch never clears it.
   */
  @IsBoolean()
  @IsOptional()
  studentsOnly?: boolean;
}

/**
 * The association a post is republished AS, or proposed TO (D38). One field for both routes: who
 * acts and what it means is the route's, never a flag in the body.
 */
export class RepublicationTargetDto {
  @IsUUID()
  associationId: string;
}

/** The author's account-wide consent to member reposts (WP-F6). */
export class RepostAccountConsentDto {
  @IsBoolean()
  allowReposts: boolean;
}

/** "Share my activity" (engagement decision 9): the person's reactions and comments told to their followers. */
export class ActivitySettingsDto {
  @IsBoolean()
  shareActivity: boolean;
}

/** One post's override of that consent (WP-F6): `null` follows the account setting again. */
export class RepostPostConsentDto {
  @ValidateIf((_o, v) => v !== null)
  @IsBoolean()
  allowReposts: boolean | null;
}

/**
 * The body of `PATCH /api/posts/:postId/pin|unpin` (WP-PIN): the space to pin in, REQUIRED - a
 * request naming none is a 400, never a guess (the body-less shim of WP-PIN went with floor `1.6.6`).
 */
export class PinPostDto {
  @IsUUID()
  spaceId: string;
}
