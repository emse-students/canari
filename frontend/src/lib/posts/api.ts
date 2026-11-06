import { apiFetch } from '$lib/utils/apiFetch';
import { ApiRefusalError, refusalFromResponse } from '$lib/utils/apiRefusalError';
import { responseOrigin } from '$lib/utils/apiJson';
import { socialUrl } from '$lib/utils/apiUrl';
import type { MediaRef } from '$lib/media';
import type { FormItem } from '$lib/forms/api';
import type { Campus, Formation } from '$lib/profile/miconnectProfile';
import { nextPostSequence, stampServed } from '$lib/posts/postCardSync';

export type PostMediaRef = MediaRef & { caption?: string };

/** @deprecated Use `PostMediaRef` instead. */
export type PostImageRef = PostMediaRef;

export interface PollOption {
  id: string;
  label: string;
  /**
   * The voters' ids on a named poll, or just the TALLY on an anonymous one - which never reveals
   * who voted for what (`Poll.anonymous`).
   */
  votes: string[] | number;
}

/**
 * A poll as it is SENT, which is neither the draft nor the stored shape.
 *
 * One type for creation and for the update, because they differed only in which fields each
 * happened to spell - the create shape had `endsAt` and no `id`, the update shape the reverse, and
 * neither omission was a rule: the server's `PollInputDto` has always accepted both. Two partial
 * copies of one contract is how `maxSelections` would have reached one path and not the other.
 */
export interface PollPayload {
  /** Existing poll ID - pass it to preserve vote history when options are unchanged. */
  id?: string;
  question: string;
  options: Array<{ label: string }>;
  multipleChoice?: boolean;
  /** How many options one voter may pick; omitted or `null` for no limit. */
  maxSelections?: number | null;
  /**
   * ISO 8601 instant at which the poll closes, or `null` to remove a deadline it had.
   *
   * The update path rebuilds the poll from this payload alone, so an omitted field and an explicit
   * `null` mean the same thing - the edit form sends the explicit one because it is EDITING a
   * field, and a cleared input is a decision rather than an absence.
   */
  endsAt?: string | null;
  /** Votes are stored without their voter and are final. Fixed at creation; the server keeps the stored value on an edit. */
  anonymous?: boolean;
}

export interface Poll {
  id: string;
  question: string;
  options: PollOption[];
  multipleChoice: boolean;
  /**
   * How many options one voter may pick, or absent/null for no limit.
   *
   * Only meaningful alongside `multipleChoice`, and enforced by the SERVER - see
   * `post-interactions.service.ts`. A poll written before 2026-09-23 has no such field.
   */
  maxSelections?: number | null;
  endsAt?: string;
  votesByUser: Record<string, string[]>;
  /**
   * Votes carry no voter and cannot be changed or retracted. Options then hold a TALLY, not a voter
   * list, and `votesByUser` is empty: the server does not know who chose what.
   */
  anonymous?: boolean;
  /** Anonymous polls only: whether THIS reader has voted. All the server can still say about them. */
  voted?: boolean;
}

export interface PostForm {
  id: string;
  title: string;
  eventId: string;
  basePrice: number;
  currency: string;
  items: FormItem[];
}

export interface PostComment {
  id: string;
  /**
   * The writer's account. ABSENT on an anonymous or an association comment for a reader who may not
   * see who is behind it (the server withholds it): no control derives a right from this field - the
   * server serves `canEdit` and `canDelete` per reader.
   */
  userId?: string;
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  text: string;
  parentId?: string | null;
  likes: string[];
  createdAt: string;
  /** Set by the server when the text was edited; absent on a comment never touched. */
  editedAt?: string | null;
  /** Written anonymously: no name is served, and the account only to moderation and its writer. */
  anonymous?: boolean;
  /** For an anonymous comment on a PERSONAL post: whether it was written by the post's author. */
  byPostAuthor?: boolean;
  /** The association this comment speaks for, when it does (it then carries no personal name). */
  association?: { id: string; name: string; slug: string; logoUrl: string | null } | null;
  /** Whether THIS reader may edit it / delete it - served per reader, never derived from `userId`. */
  canEdit?: boolean;
  canDelete?: boolean;
  /** Encrypted media attached to this comment (GIF, screenshot, etc.). */
  media?: PostMediaRef;
  /**
   * A moderation TOMBSTONE (lead, 2026-11-04): the comment was removed by a moderator but replies it
   * may not remove still answer it, so its row stays with no text, author or media.
   */
  removedByModeration?: boolean;
}

/** The longest comment, in characters. The server copy is `COMMENT_MAX_LENGTH` in `apps/social-service/src/posts/comment-page.ts`. */
export const COMMENT_MAX_LENGTH = 2000;

/** One page of whole comment threads (a head and all its replies), as `GET /posts/:id/comments` serves it. */
export interface CommentPage {
  comments: PostComment[];
  /** Pass back as `cursor` for the next page; `null` when the page was empty. */
  nextCursor: number | null;
  hasMore: boolean;
}

export interface FetchCommentsOptions {
  cursor?: number | null;
  limit?: number;
  order?: 'recent' | 'oldest';
}

/** Query string of `fetchComments`; only the options actually given are sent. */
export function buildCommentsSearchParams(opts: FetchCommentsOptions): string {
  const params = new URLSearchParams();
  if (opts.cursor !== undefined && opts.cursor !== null) params.set('cursor', String(opts.cursor));
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.order) params.set('order', opts.order);
  const q = params.toString();
  return q ? `?${q}` : '';
}

/** Display payload for posts published as an association (author identity hidden). */
export interface PostAssociationAuthor {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  /** The entity's type - what decides whether its posts may be marked "Entre étudiants". */
  type?: 'association' | 'list' | 'institution';
}

/** Validated agenda event linked from a publication. */
export interface PostLinkedCalendarEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  associationSlug: string;
}

/** One request an association of the reader made for a personal post (D38b). */
export interface PersonalRepublicationRequestState {
  associationId: string;
  /** Named on the card: "Demande envoyee au nom de X". */
  associationName: string;
  /** The proposal, which the association withdraws while it is `pending`. */
  proposalId: string;
  status: 'pending' | 'refused';
}

export interface PostEntity {
  id: string;
  /** Omitted when the post is published as an association (`association` is set). */
  authorId?: string;
  /**
   * The pencil and the bin: the post's publisher, a content moderator, or a platform admin.
   *
   * This and the two below are what the CALLING user may do with this post, one field per control,
   * answered by the server. None of them can be derived here: `authorId` is deliberately stripped
   * from association posts, so a client comparing ids finds no owner for the very posts an
   * association's officers manage, and nothing in a post says whether its reader moderates the feed.
   */
  canManage?: boolean;
  /**
   * The pencil alone: the post's AUTHOR (its publisher). Nobody else changes a post's text - not a
   * moderator, not the platform admin (owner, 2026-11-02) - so it can be false where `canManage`
   * (the bin) is true. Absent from an older server: `canManage` decides both, as it did.
   */
  canEdit?: boolean;
  /**
   * The pin (WP-PIN): a promotion PER SPACE - true when `pinSpaces` is not empty, i.e. the reader
   * governs a space where the post is visible (the platform admin, or `MODERATE` in its BDE).
   */
  canPin?: boolean;
  /** WP-PIN: the spaces the pin menu lists for this reader, each with the pin's state there. */
  pinSpaces?: PinSpace[];
  /** The flag: any logged-in reader who is not the post's own publisher. */
  canReport?: boolean;
  /** Clears `anonymous`, revealing the author again: a moderator of this post or a platform admin. */
  canUnmaskAnonymous?: boolean;
  /**
   * "Republier" (D38): an association post, and the reader may publish as another association that
   * has not republished it yet. Which one is chosen in `RepublishDialog`; the server checks it again.
   */
  canRepublish?: boolean;
  /** The poll may be voted: false for a reader who sees the post only through a read grant. */
  canVote?: boolean;
  /**
   * The comments (button, count, thread) and the lists of people (who reacted, who voted what) are
   * shown. False only for a named reader whose ONLY door is a read grant with "voit les
   * commentaires" off (owner, 2026-11-04): the post then carries no `comments`/`commentCount`, its
   * `reactions` hold the reader's own only, `otherReactionCounts` the rest as a tally, and its polls
   * are tallies. Absent is true (an older server).
   */
  canSeeComments?: boolean;
  /** With `canSeeComments: false`: everybody else's reactions, counted by type - never an id. */
  otherReactionCounts?: Record<string, number>;
  /** "Proposer a une association": the reader publishes in this post's association's name. */
  canProposeRepublication?: boolean;
  /** The republishers (ids in `republishedBy`) whose republication this reader may withdraw. */
  canUnrepublishAs?: string[];
  /**
   * "Demander a republier" (D38b): a personal post its author may be ASKED about, by
   * an association of the reader's that has not asked yet. The author decides; nothing is shown
   * before they accept.
   */
  canRequestRepublication?: boolean;
  /**
   * What the reader's associations already asked for this personal post and still stands: `pending`
   * (the card says "Demande envoyee") or `refused` (recorded, and it stands).
   */
  republicationRequests?: PersonalRepublicationRequestState[];
  /**
   * The associations that republished this post, oldest first (D38) - the card's "Republie par"
   * line. A personal post carries it too once its author accepted a request (D38b).
   */
  republishedBy?: PostAssociationAuthor[];
  /**
   * WP-F6 "Republier pour mes abonnes": the reader may repost it to their accepted followers now.
   * The server's answer (consent, blocks, anonymity, visibility); checked again on the write.
   */
  canRepost?: boolean;
  /** WP-F6: the reader reposted it - the share sheet offers to take it back. */
  repostedByMe?: boolean;
  /** WP-F6: the people the reader follows who reposted it, oldest first - "Republie par Y". */
  repostedBy?: { id: string; name: string }[];
  /**
   * WP-F6: on the reader's OWN personal post only, its repost consent - the post's override (null
   * follows the account setting) and what applies now. Absent on every other card.
   */
  repostConsent?: { override: boolean | null; effective: boolean };
  /**
   * WP-F6: beside `repostConsent`, on the reader's OWN personal post only, how many people the
   * author is shown as having reposted it - the menu's "Republie par N personnes".
   */
  repostCount?: number;
  authorDisplayName?: string | null;
  authorFirstName?: string | null;
  authorLastName?: string | null;
  markdown: string;
  mentions: string[];
  links: Array<{ url: string }>;
  media: PostMediaRef[];
  /** @deprecated Use `media` instead. Kept for backward compatibility. */
  images: PostMediaRef[];
  polls: Poll[];
  forms?: PostForm[];
  attachedFormId?: string;
  associationId?: string;
  /** Present for association posts; use instead of author fields. */
  association?: PostAssociationAuthor;
  /**
   * Fixed at creation, mutually exclusive with `association`. Strips `authorId` (and the name
   * fields above) from every reader except a content moderator or platform admin - see
   * `canUnmaskAnonymous`. Always present regardless of viewer, so the client can render the
   * generic icon even when it never received an `authorId` to draw a real avatar from.
   */
  anonymous?: boolean;
  /**
   * "Entre étudiants" (owner, 2026-11-04): read only by students and the publishing association's
   * members, whatever the path. Served to every reader, so the card says so to all of them.
   */
  studentsOnly?: boolean;
  linkedCalendarEventId?: string | null;
  linkedCalendarEvent?: PostLinkedCalendarEvent | null;
  reactions?: Record<string, string>; // userId -> reactionType
  comments?: PostComment[];
  /**
   * The post's comments in all, as the server counted them for this reader (blocked authors left
   * out). A list row carries only the newest twenty in `comments`, so the number shown is this one
   * (`posts/commentChange.ts`, `commentCountOf`); absent from a server older than the field.
   */
  commentCount?: number | null;
  /** WP-PIN: shown pinned in one of THIS READER's spaces (their own, or a read grant's cell). */
  pinned?: boolean;
  scheduledAt?: string | null;
  createdAt: string;
  /** When the post became visible: `scheduledAt` for a scheduled post, `createdAt` otherwise. The ONE time the feed orders by and the card shows. */
  publishedAt: string;
  updatedAt: string;
  /**
   * `'reel'` for a CanaReel - one vertical video that the server deletes, row and blob, at
   * `expiresAt` (C6). Absent on a server older than reels, which is a post.
   */
  kind?: PostKind;
  /** A reel's length as its author declared it (C4); `null` on a post. */
  durationMs?: number | null;
  /** When the server deletes a reel (`createdAt` + 30 days, set once); `null` on a post. */
  expiresAt?: string | null;
}

/** What a feed row is. A reel is a post of kind `'reel'`: same feed, comments, reactions, reports. */
export type PostKind = 'post' | 'reel';

/** Whether a row is a CanaReel. */
export function isReel(post: Pick<PostEntity, 'kind'>): boolean {
  return post.kind === 'reel';
}

/**
 * The server's reel numbers - the ONE copy is the server's (`GET /api/posts/reel-limits`), so an
 * installed app never carries a stale cap: the camera asks before it arms its ring timer.
 */
export interface ReelLimits {
  maxDurationMs: number;
  /**
   * The longest reel sent in a conversation (60 s, D-size, `CHAT_REEL_MAX_DURATION_MS`), served since
   * 89a81ad7d5. Required: a chat reel is never filmed nor prepared without it, and never under the
   * 90 s reel cap instead (`servedChatCapMs` checks the answer at run time).
   */
  chatMaxDurationMs: number;
  /**
   * The most conversations one "Envoyer à..." press may reach (15, `CHAT_REEL_MAX_TARGETS`), served
   * since RC-14 and absent from an older server: read through `chatReelTargetCap`, which also holds
   * it to what one take may carry on this client.
   */
  chatReelMaxTargets?: number;
  retentionDays: number;
  warningWindowDays: number;
}

/**
 * The four feeds, as DATA rather than as a union spelled out at each call site.
 *
 * It was a bare union type, and the list therefore existed twice: once here and once as a literal
 * array in `routes/posts/+page.ts`, which validated the `?feed=` parameter against it. A type
 * cannot be iterated, so a fifth feed would have compiled everywhere and been silently rejected
 * by the URL parser. It also now has a THIRD reader - the persisted preference, which is a string
 * off `localStorage` and therefore untrusted in exactly the same way a query parameter is.
 */
export const POST_FEEDS = ['all', 'followed', 'custom', 'associations'] as const;

/** Which feed the posts page is showing. */
export type PostFeed = (typeof POST_FEEDS)[number];

/**
 * The feed a reader who has never chosen one gets.
 *
 * Association posts, because that is the half of the feed nobody can miss without missing an
 * event; the other three are refinements of it.
 */
export const DEFAULT_POST_FEED: PostFeed = 'associations';

/**
 * Narrows an untrusted string to a feed, or null when it names none.
 *
 * NULL RATHER THAN THE DEFAULT, so a caller can tell "not stated" from "stated as the default" -
 * the posts page has two sources to try in order and needs to fall through the first.
 */
export function parsePostFeed(value: string | null | undefined): PostFeed | null {
  return POST_FEEDS.includes(value as PostFeed) ? (value as PostFeed) : null;
}

export interface ListPostsOptions {
  limit?: number;
  offset?: number;
  feed?: PostFeed;
  promo?: number;
  formation?: string;
  /** Only reels, or only posts; absent means both, which is what the feed asks (C7). */
  kind?: PostKind;
  /**
   * With `kind: 'reel'`: the posts whose only content is ONE picture or ONE video come too - the CanaReels list
   * (`reels/fullScreenPost.ts`). The URL carries the older switch too (`singlePhotos`): a server that
   * does not know `singleMedia` answers the pictures with the reels, and one older than both
   * answers the reels alone.
   */
  singleMedia?: boolean;
}

export interface ScheduledPost {
  id: string;
  markdown: string;
  scheduledAt: string;
  createdAt: string;
}

export async function getMyScheduledPosts(): Promise<ScheduledPost[]> {
  return request<ScheduledPost[]>('/api/posts/my-scheduled');
}

export interface CreatePostPayload {
  markdown: string;
  scheduledAt?: string;
  media?: PostMediaRef[];
  /** @deprecated Use `media` instead. */
  images?: PostMediaRef[];
  polls?: PollPayload[];
  attachedFormId?: string;
  associationId?: string;
  /** Mutually exclusive with `associationId` - the server ignores this whenever both are set. */
  anonymous?: boolean;
  /** "Entre étudiants" - offered on an association's or a list's post only (`studentsOnly.ts`). */
  studentsOnly?: boolean;
  linkedCalendarEventId?: string;
  /** `'reel'` publishes a CanaReel: exactly one video, no poll, form, event or schedule. */
  kind?: PostKind;
  /** A reel's length in ms, 1 to `ReelLimits.maxDurationMs`; required on a reel, absent otherwise. */
  durationMs?: number;
}

/** Payload for PATCH /api/posts/:id. All fields except markdown are optional. */
export interface UpdatePostPayload {
  markdown: string;
  media?: PostMediaRef[];
  /** @deprecated Use `media` instead. */
  images?: PostMediaRef[];
  polls?: PollPayload[];
  attachedFormId?: string | null;
  linkedCalendarEventId?: string | null;
  scheduledAt?: string | null;
  /** "Entre étudiants", changed after publication; absent leaves it as stored. */
  studentsOnly?: boolean;
}

/**
 * One call to social-service, refused as an `ApiRefusalError` carrying the status AND the server's
 * `code` (`refusalFromResponse`, the one reader). Exported as `socialRequest` for the generic
 * proposals (`$lib/proposals/api`) and the follows (`$lib/follows/api`), which live in the same
 * service and need the same refusal type rather than a second copy of this function.
 *
 * The code used to be dropped here (`null`, whatever the body said), so a screen mapping a social
 * refusal by its code - `PROPOSAL_SENDER_GONE`, `FOLLOW_BLOCKED` - could never see it.
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(`${socialUrl()}${path}`, init as any);

  if (!res.ok) {
    // A typed refusal: a screen reads the status and the code, never this sentence.
    throw await refusalFromResponse(res, `post-service ${path.split('?')[0]}`);
  }
  // A 2xx that is not JSON is not the app's answer - a captive portal's page, an edge's: typed here,
  // at the throw, as the edge's, rather than left to the SyntaxError of `json()`.
  if (responseOrigin(res) === 'edge') {
    throw new ApiRefusalError(
      res.status,
      null,
      `post-service ${path.split('?')[0]} answered ${res.status} without JSON (edge)`,
      { origin: 'edge' }
    );
  }
  return (await res.json()) as T;
}

export { request as socialRequest };

/** The query string of a list read (exported for its test). */
export function buildListPostsSearchParams(options: ListPostsOptions): string {
  const p = new URLSearchParams();
  if (options.limit != null) p.set('limit', String(options.limit));
  if (options.offset != null) p.set('offset', String(options.offset));
  if (options.feed && options.feed !== 'all') p.set('feed', options.feed);
  if (options.promo != null && !Number.isNaN(options.promo)) p.set('promo', String(options.promo));
  if (options.formation?.trim()) p.set('formation', options.formation.trim());
  if (options.kind) p.set('kind', options.kind);
  if (options.singleMedia) {
    p.set('singleMedia', 'true');
    // An installed server knows only the pictures' switch and drops the unknown one: it keeps
    // serving pictures, and the client draws no video it was not sent (docs/wiki/legacy-compatibility.md).
    p.set('singlePhotos', 'true');
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export async function searchPosts(
  q: string,
  opts: { limit?: number; offset?: number } = {}
): Promise<PostEntity[]> {
  const p = new URLSearchParams({ q });
  if (opts.limit != null) p.set('limit', String(opts.limit));
  if (opts.offset != null) p.set('offset', String(opts.offset));
  return readPosts<PostEntity[]>(`/api/posts/search?${p}`);
}

/**
 * A read of posts, its rows stamped with the point it was ISSUED at (`stampServed`): a card compares
 * that point with its own writes to know which of the two is newer (`PostCardLedger`).
 */
async function readPosts<T extends PostEntity | PostEntity[]>(path: string): Promise<T> {
  const issuedAt = nextPostSequence();
  const rows = await request<T>(path);
  stampServed(rows, issuedAt);
  return rows;
}

export async function getPost(postId: string): Promise<PostEntity> {
  return readPosts<PostEntity>(`/api/posts/${postId}`);
}

export async function updatePost(postId: string, payload: UpdatePostPayload): Promise<PostEntity> {
  return request<PostEntity>(`/api/posts/${postId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export async function deletePost(postId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/posts/${postId}`, { method: 'DELETE' });
}

/**
 * Takes back a post the publish queue may have created (`POST /api/posts/:id/withdraw`): the id is
 * retired on the server, so a create still on its way is refused, and the post is deleted if it
 * landed. `mediaIds` are the post's uploaded media: social-service deletes the ones no live row
 * cites, under this caller as their uploader. `deleted` says whether a row was there.
 */
export async function withdrawPost(
  postId: string,
  mediaIds: string[]
): Promise<{ ok: boolean; deleted: boolean }> {
  return request<{ ok: boolean; deleted: boolean }>(`/api/posts/${postId}/withdraw`, {
    method: 'POST',
    body: JSON.stringify({ mediaIds }),
  });
}

/** @param limitOrOptions Pass a number for backward compatibility (`limit` only) or query options. */
export async function listPosts(
  limitOrOptions: number | ListPostsOptions = 30
): Promise<PostEntity[]> {
  const opts: ListPostsOptions =
    typeof limitOrOptions === 'number' ? { limit: limitOrOptions } : limitOrOptions;
  const q = buildListPostsSearchParams(opts);
  return readPosts<PostEntity[]>(`/api/posts${q}`);
}

/**
 * Whether the signed-in reader may use the feed at all - the very SQL `FeedAudienceGuard` refuses
 * with (WP6b). Read through `$lib/posts/feedAudience`, never directly.
 */
export async function fetchFeedAudience(): Promise<{ inAudience: boolean }> {
  return request<{ inAudience: boolean }>('/api/posts/audience');
}

/** The server's reel numbers (`ReelLimits`). */
export async function getReelLimits(): Promise<ReelLimits> {
  return request<ReelLimits>('/api/posts/reel-limits');
}

export async function createPost(payload: CreatePostPayload): Promise<PostEntity> {
  return request<PostEntity>('/api/posts', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function votePoll(
  postId: string,
  pollId: string,
  payload: { optionIds: string[] }
): Promise<PostEntity> {
  return request<PostEntity>(`/api/posts/${postId}/polls/${pollId}/vote`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function addReaction(
  postId: string,
  reactionType: string
): Promise<{
  ok: boolean;
  reactions: Record<string, string>;
  otherReactionCounts?: Record<string, number>;
}> {
  return request(`/api/posts/${postId}/reactions`, {
    method: 'POST',
    body: JSON.stringify({ reactionType }),
  });
}

export async function removeReaction(postId: string): Promise<{
  ok: boolean;
  reactions: Record<string, string>;
  otherReactionCounts?: Record<string, number>;
}> {
  return request(`/api/posts/${postId}/reactions`, { method: 'DELETE' });
}

export async function addComment(
  postId: string,
  payload: {
    text: string;
    parentId?: string;
    media?: PostImageRef;
    /** Comment AS this association (needs `POST_AS_ASSO` there; the server checks). */
    associationId?: string;
    /** Comment anonymously (any member may; exclusive with `associationId`). */
    anonymous?: boolean;
  }
): Promise<{ ok: boolean; comment: PostComment }> {
  return request(`/api/posts/${postId}/comments`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** One page of a post's comments, as whole threads - see `CommentPage`. */
export async function fetchComments(
  postId: string,
  opts: FetchCommentsOptions = {}
): Promise<CommentPage> {
  return request<CommentPage>(`/api/posts/${postId}/comments${buildCommentsSearchParams(opts)}`);
}

export async function likeComment(
  postId: string,
  commentId: string
): Promise<{ ok: boolean; comment: PostComment }> {
  return request(`/api/posts/${postId}/comments/${commentId}/like`, { method: 'POST' });
}

export async function editComment(
  postId: string,
  commentId: string,
  text: string
): Promise<{ ok: boolean; comment: PostComment }> {
  return request(`/api/posts/${postId}/comments/${commentId}`, {
    method: 'PATCH',
    body: JSON.stringify({ text }),
  });
}

/** The server's answer to a comment's delete: what it dropped, and what it kept as a tombstone. */
export interface CommentDeleteAnswer {
  ok: boolean;
  /**
   * Every row the delete took: the comment and its descendants the deleter may remove. Absent from
   * a server older than the moderation tombstone (it answered `{ ok: true }` alone), which the thread
   * reads as version skew (`postCommentThread.remove`).
   */
  removedIds?: string[];
  /**
   * The rows kept as moderation tombstones (`removedByModeration`), served as this reader sees them:
   * a moderator's delete met a reply it does not moderate, which stays in its context. Absent when none.
   */
  tombstones?: PostComment[];
  /**
   * How many COUNTED comments left the thread: the live rows removed plus the rows turned into
   * tombstones (a tombstone is not counted, a pruned one already was not). Absent from an older server.
   */
  countedOut?: number;
}

export async function deleteComment(
  postId: string,
  commentId: string
): Promise<CommentDeleteAnswer> {
  return request(`/api/posts/${postId}/comments/${commentId}`, { method: 'DELETE' });
}

/**
 * A pin's state in one space (WP-PIN): `shown` (one of the 3 that space's readers see first),
 * `pending` ("en attente": kept, not shown until a shown one is unpinned), or `null` (not pinned).
 */
export type PinState = 'shown' | 'pending' | null;

/** One space where the reader may pin a post, as the server serves it on the card. */
export interface PinSpace {
  spaceId: string;
  formation: Formation;
  campus: Campus;
  state: PinState;
}

/** What a pin or unpin answers: the post's state IN THAT SPACE after the act. */
export interface PinResult {
  ok: boolean;
  pinned: boolean;
  spaceId: string;
  state: PinState;
}

/**
 * Pins the post in ONE space, for that space's readers only (WP-PIN). A refusal is typed:
 * `space_pin_limit` (the space already shows 3), read with `refusalCode`.
 */
export async function pinPost(postId: string, spaceId: string): Promise<PinResult> {
  return request(`/api/posts/${postId}/pin`, {
    method: 'PATCH',
    body: JSON.stringify({ spaceId }),
  });
}

/** Unpins the post from ONE space (WP-PIN). */
export async function unpinPost(postId: string, spaceId: string): Promise<PinResult> {
  return request(`/api/posts/${postId}/unpin`, {
    method: 'PATCH',
    body: JSON.stringify({ spaceId }),
  });
}

/** Clears the anonymous flag on a post, revealing its author again. Content moderators. */
export async function unmaskPost(postId: string): Promise<{ ok: boolean }> {
  return request(`/api/posts/${postId}/unmask`, { method: 'PATCH' });
}

/**
 * Republishes the post AS `associationId`, at once (D38): the reader publishes in that
 * association's name and already sees the post. 409 when that association already did.
 */
export async function republishPost(postId: string, associationId: string): Promise<unknown> {
  return request(`/api/posts/${postId}/republications`, {
    method: 'POST',
    body: JSON.stringify({ associationId }),
  });
}

/** Withdraws `associationId`'s own republication of the post. */
export async function unrepublishPost(
  postId: string,
  associationId: string
): Promise<{ ok: boolean }> {
  return request(`/api/posts/${postId}/republications/${associationId}`, { method: 'DELETE' });
}

/**
 * Sends the post to ANOTHER association, whose publishers accept or refuse it on its management
 * page. 409 when that association already holds a proposal for it, or already republished it.
 */
export async function proposeRepublication(
  postId: string,
  associationId: string
): Promise<unknown> {
  return request(`/api/posts/${postId}/republication-proposals`, {
    method: 'POST',
    body: JSON.stringify({ associationId }),
  });
}

/**
 * Asks the AUTHOR of a personal post to let `associationId` carry it (D38b). Nothing is visible
 * before the author accepts. A refusal carries a typed `code` (`REPOST_PERSONAL_*`), read with
 * `refusalCode`: 409 for a request that already stands or a cap reached, 403 for a block.
 */
export async function requestPersonalRepublication(
  postId: string,
  associationId: string
): Promise<unknown> {
  return request(`/api/posts/${postId}/republication-requests`, {
    method: 'POST',
    body: JSON.stringify({ associationId }),
  });
}

/**
 * WP-F6: reposts the post to the caller's ACCEPTED followers. A refusal carries a typed `code`
 * (`MEMBER_REPOST_*`), read with `refusalCode`.
 */
export async function repostToFollowers(postId: string): Promise<{ postId: string }> {
  return request(`/api/posts/${postId}/reposts`, { method: 'POST' });
}

/** WP-F6: takes the caller's own repost back. */
export async function undoRepost(postId: string): Promise<{ ok: boolean }> {
  return request(`/api/posts/${postId}/reposts`, { method: 'DELETE' });
}

/** WP-F6: the caller's account-wide consent to member reposts (ON when never set). */
export async function getRepostSettings(): Promise<{ allowReposts: boolean }> {
  return request('/api/posts/me/repost-settings');
}

/** WP-F6: sets it; turning it off removes, at once, every repost it no longer covers. */
export async function setRepostSettings(
  allowReposts: boolean
): Promise<{ allowReposts: boolean; removed: number }> {
  return request('/api/posts/me/repost-settings', {
    method: 'PUT',
    body: JSON.stringify({ allowReposts }),
  });
}

/** WP-F6: the author's override for one post - true, false, or null to follow the setting. */
export async function setPostRepostConsent(
  postId: string,
  allowReposts: boolean | null
): Promise<{ override: boolean | null; effective: boolean; removed: number }> {
  return request(`/api/posts/${postId}/repost-consent`, {
    method: 'PUT',
    body: JSON.stringify({ allowReposts }),
  });
}

/** A post hidden by moderation, with its pending report count. Admin only. */
export interface HiddenPost {
  id: string;
  authorId: string | null;
  associationId: string | null;
  markdown: string;
  createdAt: string;
  pendingReportCount: number;
}

/** Returns all posts currently hidden by moderation. Global admin only. */
export async function listHiddenPosts(): Promise<HiddenPost[]> {
  return request<HiddenPost[]>('/api/posts/hidden');
}

/** Hides a post from public feeds (moderation). Global admin only. */
export async function hidePost(postId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/posts/${postId}/hide`, { method: 'PATCH' });
}

/** Restores a moderation-hidden post back to the public feed. Global admin only. */
export async function unhidePost(postId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/posts/${postId}/unhide`, { method: 'PATCH' });
}

export interface PostNotification {
  id: string;
  type: string;
  postId: string;
  actorId: string;
  actorName: string;
  /**
   * Set only for `type === 'association_post'`. `actorId` on this row is the publishing MEMBER,
   * not the association - see the backend `PostNotification` entity's own docblock for why - so
   * the association's identity/logo has nowhere else to come from for rendering an avatar.
   */
  associationId?: string | null;
  associationLogoUrl?: string | null;
  text: string;
  /** Structured facts a client draws itself (a booking notice's place, slot and zone); null on older rows. */
  meta?: Record<string, unknown> | null;
  read: boolean;
  createdAt: string;
}

export async function getPostNotifications(limit = 30): Promise<PostNotification[]> {
  return request<PostNotification[]>(`/api/posts/notifications?limit=${limit}`);
}

export async function markPostNotificationsRead(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/posts/notifications/read-all', { method: 'POST' });
}

/** Marks notifications about one post as read. */
export async function markPostNotificationsReadForPost(postId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/posts/${postId}/notifications/read`, { method: 'POST' });
}

// ── Form reminders ────────────────────────────────────────────────────────────

export async function subscribeFormReminder(formId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/forms/${encodeURIComponent(formId)}/remind`, {
    method: 'POST',
  });
}

export async function unsubscribeFormReminder(formId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/forms/${encodeURIComponent(formId)}/remind`, {
    method: 'DELETE',
  });
}

export async function checkFormReminder(formId: string): Promise<{ subscribed: boolean }> {
  return request<{ subscribed: boolean }>(`/api/forms/${encodeURIComponent(formId)}/remind`);
}
