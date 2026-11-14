import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Logger,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post as HttpPost,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { FeedAudienceGuard } from './feed-audience.guard';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { PostsService } from './posts.service';
import { assertCreateKindShape } from './reel-rules';
import { resolveListFeed } from './list-feed';
import { PostInteractionsService } from './post-interactions.service';
import { PostNotificationsService, bellPageLimit } from './post-notifications.service';
import { postPageLimit } from './post-page';
import { CLIENT_VERSION_HEADER, clientVersionOf } from '../common/client-version';
import { AssociationsService } from '../associations/associations.service';
import { withOneEventIcsSig } from '../associations/agenda-signature';
import { ModerationService } from '../moderation/moderation.service';
import { MODERATOR_REQUIRED } from '../spaces/bde-moderation';
import {
  CreatePostDto,
  ListPostsQueryDto,
  SearchPostsQueryDto,
  VotePollDto,
  AddCommentDto,
  ListCommentsQueryDto,
  AddReactionDto,
  EditCommentDto,
  UpdatePostDto,
  WithdrawPostDto,
} from './dto/post.dto';

/** Manages post resources including reactions, comments, polls, and notifications. */
@Controller('posts')
export class PostsController {
  private readonly logger = new Logger(PostsController.name);

  constructor(
    private readonly service: PostsService,
    private readonly interactions: PostInteractionsService,
    private readonly notifications: PostNotificationsService,
    private readonly associationsService: AssociationsService,
    private readonly moderationService: ModerationService
  ) {}

  /** Throws 403 if the given user is currently muted. */
  private async assertNotMuted(userId: string): Promise<void> {
    const muted = await this.moderationService.isUserMuted(userId);
    if (muted)
      throw new ForbiddenException('Your account has been restricted. You cannot post or react.');
  }

  /** Returns the health status of the post service. */
  @Get('health')
  health() {
    return { service: 'post-service', status: 'ok', timestamp: new Date().toISOString() };
  }

  /**
   * Returns the notification list for the calling user - only the types the caller's build can draw,
   * read from the build it names in `X-Canari-Client-Version` (`notification-client-floor.ts`).
   */
  @UseGuards(NginxAuthGuard)
  @Get('notifications')
  getNotifications(
    @Headers('x-user-id') xUserId: string,
    @Query('limit') limit?: string,
    @Headers(CLIENT_VERSION_HEADER) clientVersion?: string
  ) {
    return this.notifications.getNotifications(
      xUserId,
      bellPageLimit(limit),
      clientVersionOf(clientVersion)
    );
  }

  /** Marks all notifications as read for the calling user. */
  @UseGuards(NginxAuthGuard)
  @HttpPost('notifications/read-all')
  markAllRead(@Headers('x-user-id') xUserId: string) {
    return this.notifications.markAllRead(xUserId);
  }

  /** Marks notifications about one post as read when the post is opened. */
  @UseGuards(NginxAuthGuard)
  @HttpPost(':postId/notifications/read')
  markPostRead(
    @Headers('x-user-id') xUserId: string,
    @Param('postId', ParseUUIDPipe) postId: string
  ) {
    return this.notifications.markPostRead(xUserId, postId);
  }

  /**
   * The future-scheduled posts the caller may EDIT (their own, and an association's they speak
   * for), as whole feed cards, soonest first - the editors' strip at the top of `/posts`.
   */
  @UseGuards(NginxAuthGuard)
  @Get('scheduled-to-edit')
  getScheduledPostsIMayEdit(@Headers('x-user-id') xUserId: string) {
    return this.service.getScheduledPostsIMayEdit(xUserId);
  }

  /**
   * LEGACY (docs/wiki/legacy-compatibility.md): the route builds before `1.6.11` call. It answers
   * the same list as `scheduled-to-edit` - a superset of the `{ id, markdown, scheduledAt,
   * createdAt }` they read, with the association posts the caller may now edit too.
   */
  @UseGuards(NginxAuthGuard)
  @Get('my-scheduled')
  getMyScheduledPostsLegacy(@Headers('x-user-id') xUserId: string) {
    this.logger.log('[LEGACY] GET /api/posts/my-scheduled served');
    return this.service.getScheduledPostsIMayEdit(xUserId);
  }

  /**
   * The CanaReels numbers (longest reel, retention IN FORCE, "about to expire" window), so no client
   * is built carrying a copy - see `reel.constants.ts`. Declared before `:postId` like every literal
   * segment here.
   */
  @UseGuards(NginxAuthGuard)
  @Get('reel-limits')
  getReelLimits() {
    return this.service.reelLimitsInForce();
  }

  /**
   * Whether the caller may use the feed at all - the SAME SQL as `FeedAudienceGuard`, so the
   * client's redirect and the server's refusal cannot disagree (WP6b). Never refuses: an answer of
   * `false` is what the client acts on. Declared before `:postId` like every literal segment here.
   */
  @UseGuards(NginxAuthGuard)
  @Get('audience')
  async getFeedAudience(@Headers('x-user-id') xUserId: string) {
    return { inAudience: await this.service.isInFeedAudience(xUserId) };
  }

  /** The caller's own live reels, soonest expiry first, flagged when they are about to expire. */
  @UseGuards(NginxAuthGuard)
  @Get('my-reels')
  getMyReels(@Headers('x-user-id') xUserId: string) {
    return this.service.getMyReels(xUserId);
  }

  /** Returns all posts currently hidden by moderation, with their pending report count. Content moderators. */
  @UseGuards(NginxAuthGuard)
  @Get('hidden')
  async getHiddenPosts(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin: string | undefined
  ) {
    await this.assertContentModerator(xUserId, xGlobalAdmin);
    // The door is "moderates somewhere"; the list is narrowed to the caller's scope (2026-11-02).
    return this.service.getHiddenPosts({ userId: xUserId, isGlobalAdmin: xGlobalAdmin === 'true' });
  }

  /** Returns posts matching the given search query. */
  @UseGuards(NginxAuthGuard, FeedAudienceGuard)
  @Get('search')
  searchPosts(
    @Query() query: SearchPostsQueryDto,
    @Headers('x-user-id') xUserId?: string,
    @Headers('x-global-admin') xGlobalAdmin?: string
  ) {
    // The viewer is carried here for the same reason `listPosts` carries it: every row is stamped
    // with `canManage`, and a search result renders the same card as a feed row.
    const limit = postPageLimit(query.limit, 20);
    return this.service.searchPosts(query.q ?? '', limit, query.offset ?? 0, {
      viewerUserId: xUserId,
      isAdmin: xGlobalAdmin === 'true',
    });
  }

  /**
   * The caller's SUGGESTED POSTS (engagement WP-7, decision 8): popular posts they already see by the
   * space rule, from accounts they do not follow - feed rows, which the client places in Mon espace
   * marked "Suggestion" (at most one in every 8 items, never two in a row: L13). `me/...` is a
   * literal no post id is.
   */
  @UseGuards(NginxAuthGuard, FeedAudienceGuard)
  @Get('me/suggested-posts')
  listSuggestedPosts(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin?: string
  ) {
    return this.service.listSuggestedPosts(xUserId, xGlobalAdmin === 'true');
  }

  /**
   * The spaces an INSTITUTION's post may target (owner, 2026-11-10): every space of its own
   * audience, which the composer offers to tick and the publish checks a reach against. Only for a
   * caller who may publish as it (403), and only for an institution (400 `institution_reach_not_offered`).
   */
  @UseGuards(NginxAuthGuard)
  @Get('reach-options/:associationId')
  listInstitutionReachOptions(
    @Param('associationId', ParseUUIDPipe) associationId: string,
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin?: string
  ) {
    return this.service.listInstitutionReachOptions(
      associationId,
      xUserId,
      xGlobalAdmin === 'true'
    );
  }

  /** Returns a paginated list of posts for the requested feed. */
  @UseGuards(NginxAuthGuard, FeedAudienceGuard)
  @Get()
  listPosts(
    @Query() query: ListPostsQueryDto,
    @Headers('x-user-id') xUserId?: string,
    @Headers('x-global-admin') xGlobalAdmin?: string
  ) {
    // LEGACY SHIM (docs/wiki/legacy-compatibility.md): `kind=reel` on `all` IS the CanaReels viewer
    // (`list-feed.ts`). At `log` level: its count is what the removal is read on.
    const { feed, legacyViewerShape } = resolveListFeed(query.feed, query.kind);
    if (legacyViewerShape) {
      this.logger.log(
        '[LEGACY] list: kind=reel on feed=all read as feed=reels (an installed client)'
      );
    }
    if ((feed === 'followed' || feed === 'foryou') && !xUserId) {
      throw new UnauthorizedException(`Authentication required for ${feed} feed`);
    }
    return this.service.listPosts({
      limit: postPageLimit(query.limit, 30),
      offset: query.offset ?? 0,
      feed,
      viewerUserId: xUserId,
      isAdmin: xGlobalAdmin === 'true',
      promo: query.promo,
      formation: query.formation?.trim() || undefined,
      kind: query.kind,
      multiMedia: query.multiMedia === true,
      withReplays: query.withReplays === true,
      ranked: feed === 'reels' && query.ranked === true,
      ...(feed === 'foryou' || (feed === 'reels' && query.ranked === true)
        ? { asOf: query.asOf, cursor: query.cursor }
        : {}),
    });
  }

  /** Creates a new post on behalf of the calling user or a managed association. */
  @UseGuards(NginxAuthGuard)
  @HttpPost()
  async createPost(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Body() body: CreatePostDto
  ) {
    await this.assertNotMuted(xUserId);
    // The shape of the request first - a malformed reel is refused before anything is claimed.
    assertCreateKindShape(body);
    const isGlobalAdmin = xGlobalAdmin === 'true';
    if (body.associationId) {
      const canPost = await this.associationsService.canPostAs(xUserId, body.associationId, {
        isGlobalAdmin,
      });
      if (!canPost) {
        throw new BadRequestException('You need admin or owner role to post as this association');
      }
    }
    // Mutually exclusive with speaking for an association, which already anonymizes its author
    // unconditionally - never trust the client to have respected that itself.
    const anonymous = !!body.anonymous && !body.associationId;
    // THE SAME FLAG REACHES BOTH HALVES OF THIS REQUEST. It decided that the write was allowed
    // above; it must also decide what the publisher is told they may do with the row it created,
    // or the one identity is read twice and disagrees with itself.
    return this.service.createPost({ ...body, authorId: xUserId, anonymous }, isGlobalAdmin);
  }

  /** Association agenda entry linked to this post (same association), if configured. */
  @UseGuards(NginxAuthGuard, FeedAudienceGuard)
  @Get(':postId/calendar-link')
  async getPostCalendarLink(
    @Param('postId', ParseUUIDPipe) postId: string,
    @Headers('x-user-id') xUserId: string
  ) {
    // The event of a post the reader may not see is that post's content: same 404 as the post.
    await this.service.assertVisible(postId, xUserId, 'READ_OR_REACT');
    const linkedEvent = await this.associationsService.findCalendarEventByLinkedPost(
      postId,
      xUserId
    );
    // The detail modal opened from a post offers "add to my calendar" like the agenda's: same `icsSig`.
    return { linkedEvent: withOneEventIcsSig(linkedEvent) };
  }

  /** The reverse of the above: the post (if any) linking to this calendar event. */
  @UseGuards(NginxAuthGuard, FeedAudienceGuard)
  @Get('calendar-link/:eventId')
  async getPostLinkedToCalendarEvent(
    @Param('eventId') eventId: string,
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin?: string
  ) {
    const linkedPost = await this.service.findPostLinkedToCalendarEvent(
      eventId,
      xUserId,
      xGlobalAdmin === 'true'
    );
    return { linkedPost };
  }

  /**
   * Returns a single post by its ID. Global admins may load moderation-hidden posts; the author
   * may load their own post before its scheduled publication date, nobody else can.
   */
  @UseGuards(NginxAuthGuard, FeedAudienceGuard)
  @Get(':postId')
  getPost(
    @Param('postId', ParseUUIDPipe) postId: string,
    @Headers('x-global-admin') xGlobalAdmin?: string,
    @Headers('x-user-id') userId?: string,
    @Query('withReplays') withReplays?: string
  ) {
    return this.service.getById(postId, {
      allowHidden: xGlobalAdmin === 'true',
      viewerId: userId,
      isGlobalAdmin: xGlobalAdmin === 'true',
      withReplays: withReplays === 'true',
    });
  }

  /**
   * Updates a post's content: its author alone (a POST_AS_ASSO holder for an association's post),
   * never a moderator nor the global admin (owner, 2026-11-02; `PostsService.assertMayEdit`).
   */
  @UseGuards(NginxAuthGuard)
  @Patch(':postId')
  updatePost(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') ga: string,
    @Param('postId', ParseUUIDPipe) postId: string,
    @Body() body: UpdatePostDto
  ) {
    return this.service.updatePost(postId, xUserId, body, ga === 'true');
  }

  /**
   * The author takes back a post the app queued under a client id, whether or not its create landed:
   * the id is retired (410 on a later create), the row, if any, deleted, and the uploaded media no
   * live row cites deleted (`withdrawPost`). Only ever the caller's own post, admin or not.
   */
  @UseGuards(NginxAuthGuard)
  @HttpPost(':postId/withdraw')
  withdrawPost(
    @Headers('x-user-id') xUserId: string,
    @Param('postId', ParseUUIDPipe) postId: string,
    @Body() body: WithdrawPostDto
  ) {
    return this.service.withdrawPost(postId, xUserId, body?.mediaIds ?? []);
  }

  /** Deletes a post; global admins may delete any post. */
  @UseGuards(NginxAuthGuard)
  @Delete(':postId')
  deletePost(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Param('postId', ParseUUIDPipe) postId: string
  ) {
    return this.service.deletePost(postId, xUserId, xGlobalAdmin === 'true');
  }

  /**
   * Records a vote for the calling user on the specified poll option. Like every interaction that
   * ADDS something (a vote, a reaction, a comment, a like), it is refused with the read's own 404
   * on a post the caller may not see (WP6b): an id is not a permission. Taking back one's own
   * reaction or comment is not gated - it adds nothing.
   *
   * A vote is refused wherever opening the post would be (`assertMayVote`, the gate `getById`
   * uses, with the vote's grant-free audience), and the answer is the post served to this reader
   * (`serveToReader`), like every other route answering with one post.
   */
  @UseGuards(NginxAuthGuard)
  @HttpPost(':postId/polls/:pollId/vote')
  async votePoll(
    @Headers('x-user-id') xUserId: string,
    @Param('postId', ParseUUIDPipe) postId: string,
    @Param('pollId') pollId: string,
    @Body() body: VotePollDto,
    @Headers('x-global-admin') xGlobalAdmin?: string
  ) {
    await this.service.assertMayVote(postId, xUserId);
    const stored = await this.interactions.votePoll(postId, pollId, { ...body, userId: xUserId });
    return this.service.serveToReader(stored, {
      viewerId: xUserId,
      isGlobalAdmin: xGlobalAdmin === 'true',
    });
  }

  /** Adds an emoji reaction from the calling user to a post. */
  @UseGuards(NginxAuthGuard)
  @HttpPost(':postId/reactions')
  async addReaction(
    @Headers('x-user-id') xUserId: string,
    @Param('postId', ParseUUIDPipe) postId: string,
    @Body() body: AddReactionDto
  ) {
    await this.assertNotMuted(xUserId);
    const { post } = await this.service.assertVisible(postId, xUserId, 'READ_OR_REACT');
    const answer = await this.interactions.addReaction(postId, xUserId, body.reactionType, post);
    // The stored map names who reacted: served per reader, like every other read of it.
    return this.service.serveReactionsTo(postId, xUserId, answer);
  }

  /** Removes the calling user's reaction from a post. */
  @UseGuards(NginxAuthGuard)
  @Delete(':postId/reactions')
  async removeReaction(
    @Headers('x-user-id') xUserId: string,
    @Param('postId', ParseUUIDPipe) postId: string
  ) {
    const answer = await this.interactions.removeReaction(postId, xUserId);
    // Not gated (it adds nothing), so its answer is what must not list the reactors to whoever
    // holds an id: `serveReactionsTo` hands an outsider their own entry only.
    return this.service.serveReactionsTo(postId, xUserId, answer);
  }

  /** One page of comments as whole threads: `?cursor=<position>&limit=20&order=recent|oldest`. */
  @UseGuards(NginxAuthGuard, FeedAudienceGuard)
  @Get(':postId/comments')
  listComments(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Param('postId', ParseUUIDPipe) postId: string,
    @Query() query: ListCommentsQueryDto
  ) {
    return this.service.listComments(postId, xUserId, {
      ...query,
      isGlobalAdmin: xGlobalAdmin === 'true',
    });
  }

  /** Adds a comment from the calling user to a post. */
  @UseGuards(NginxAuthGuard)
  @HttpPost(':postId/comments')
  async addComment(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Param('postId', ParseUUIDPipe) postId: string,
    @Body() body: AddCommentDto
  ) {
    // The mute is the real account's, whatever the comment will say it is.
    await this.assertNotMuted(xUserId);
    await this.service.assertVisible(postId, xUserId, 'COMMENT');
    const isGlobalAdmin = xGlobalAdmin === 'true';
    // Speaking for an association is the right posts need, asked BEFORE anything is written: an
    // older server would have ignored the field and published under the person's own name.
    if (body.associationId) {
      const canPost = await this.associationsService.canPostAs(xUserId, body.associationId, {
        isGlobalAdmin,
      });
      if (!canPost) {
        throw new ForbiddenException('You may not comment in this association name');
      }
    }
    return this.interactions.addComment(postId, { ...body, userId: xUserId }, isGlobalAdmin);
  }

  /** Toggles a like from the calling user on a specific comment. */
  @UseGuards(NginxAuthGuard)
  @HttpPost(':postId/comments/:commentId/like')
  async likeComment(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Param('postId', ParseUUIDPipe) postId: string,
    @Param('commentId') commentId: string
  ) {
    await this.service.assertVisible(postId, xUserId, 'COMMENT');
    return this.interactions.likeComment(postId, commentId, xUserId, xGlobalAdmin === 'true');
  }

  /**
   * Updates the text of a comment the caller may edit (`commentRights`). Behind the `'COMMENT'` read:
   * the answer serves the comment (who liked it included) to a reader the comments may be withheld
   * from - a named reader's own comment, written while their switch was on. Deleting it stays open.
   */
  @UseGuards(NginxAuthGuard)
  @Patch(':postId/comments/:commentId')
  async editComment(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Param('postId', ParseUUIDPipe) postId: string,
    @Param('commentId') commentId: string,
    @Body() body: EditCommentDto
  ) {
    await this.service.assertVisible(postId, xUserId, 'COMMENT', {
      allowHidden: xGlobalAdmin === 'true',
    });
    return this.interactions.editComment(
      postId,
      commentId,
      xUserId,
      body.text,
      xGlobalAdmin === 'true'
    );
  }

  /** Deletes a comment the caller may delete (`commentRights`). */
  @UseGuards(NginxAuthGuard)
  @Delete(':postId/comments/:commentId')
  deleteComment(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Param('postId', ParseUUIDPipe) postId: string,
    @Param('commentId') commentId: string
  ) {
    return this.interactions.deleteComment(postId, commentId, xUserId, xGlobalAdmin === 'true');
  }

  /** Clears the anonymous flag on a post, revealing its author again. Content moderators. */
  @UseGuards(NginxAuthGuard)
  @Patch(':postId/unmask')
  async unmaskPost(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Param('postId', ParseUUIDPipe) postId: string
  ) {
    await this.assertModeratesPost(xUserId, xGlobalAdmin, postId);
    return this.service.clearAnonymousFlag(postId);
  }

  /** Refuses the caller unless they moderate SOMEWHERE - the door of the moderation lists. */
  private async assertContentModerator(
    userId: string,
    globalAdminHeader: string | undefined
  ): Promise<void> {
    const mayModerate = await this.associationsService.isContentModerator(userId, {
      isGlobalAdmin: globalAdminHeader === 'true',
    });
    if (!mayModerate) {
      throw new ForbiddenException({
        code: MODERATOR_REQUIRED,
        message: 'Content moderator required',
      });
    }
  }

  /**
   * Refuses the caller unless they moderate THIS post (owner, 2026-11-02): a platform admin, or a
   * BDE `MODERATE` holder whose governed spaces hold it. A BDE moderator outside its scope is a 403
   * `MODERATION_OUT_OF_SCOPE`, a caller who moderates nowhere a 403 `MODERATOR_REQUIRED` - never a
   * 401, which may log a user out.
   */
  private async assertModeratesPost(
    userId: string,
    globalAdminHeader: string | undefined,
    postId: string
  ): Promise<void> {
    const isGlobalAdmin = globalAdminHeader === 'true';
    if (await this.associationsService.mayModeratePost(userId, postId, { isGlobalAdmin })) return;
    await this.associationsService.refuseModeration(userId, { kind: 'post', id: postId });
  }

  /** Hides a post from public feeds (moderation). Content moderators. */
  @UseGuards(NginxAuthGuard)
  @Patch(':postId/hide')
  async hidePost(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Param('postId', ParseUUIDPipe) postId: string
  ) {
    await this.assertModeratesPost(xUserId, xGlobalAdmin, postId);
    return this.service.hidePostByModeration(postId);
  }

  /** Restores a moderation-hidden post back to the public feed. Content moderators. */
  @UseGuards(NginxAuthGuard)
  @Patch(':postId/unhide')
  async unhidePost(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Param('postId', ParseUUIDPipe) postId: string
  ) {
    await this.assertModeratesPost(xUserId, xGlobalAdmin, postId);
    return this.service.unhidePost(postId);
  }
}
