import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Patch,
  Post as HttpPost,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { PostsService } from './posts.service';
import { PostInteractionsService } from './post-interactions.service';
import { PostNotificationsService } from './post-notifications.service';
import { AssociationsService } from '../associations/associations.service';
import { FollowsService } from '../follows/follows.service';
import { ModerationService } from '../moderation/moderation.service';
import {
  CreatePostDto,
  ListPostsQueryDto,
  VotePollDto,
  AddCommentDto,
  AddReactionDto,
  EditCommentDto,
  UpdatePostDto,
  ReportPostDto,
  SubmitFormDto,
} from './dto/post.dto';

/** Manages post resources including reactions, comments, polls, and notifications. */
@Controller('posts')
export class PostsController {
  constructor(
    private readonly service: PostsService,
    private readonly interactions: PostInteractionsService,
    private readonly notifications: PostNotificationsService,
    private readonly associationsService: AssociationsService,
    private readonly followsService: FollowsService,
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

  /** Returns the notification list for the calling user. */
  @UseGuards(NginxAuthGuard)
  @Get('notifications')
  getNotifications(@Headers('x-user-id') xUserId: string, @Query('limit') limit?: string) {
    return this.notifications.getNotifications(xUserId, Number(limit ?? 30));
  }

  /** Marks all notifications as read for the calling user. */
  @UseGuards(NginxAuthGuard)
  @HttpPost('notifications/read-all')
  markAllRead(@Headers('x-user-id') xUserId: string) {
    return this.notifications.markAllRead(xUserId);
  }

  /** Returns all scheduled posts authored by the calling user. */
  @UseGuards(NginxAuthGuard)
  @Get('my-scheduled')
  getMyScheduledPosts(@Headers('x-user-id') xUserId: string) {
    return this.service.getMyScheduledPosts(xUserId);
  }

  /** Returns all posts that have at least one report. Global admin only. */
  @UseGuards(NginxAuthGuard)
  @Get('reported')
  getReportedPosts(
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string
  ) {
    if (xGlobalAdmin !== 'true') throw new UnauthorizedException('Global admin required');
    return this.service.getReportedPosts(Math.min(Number(limit ?? 50), 200), Number(offset ?? 0));
  }

  /** Returns all posts currently hidden by moderation, with their pending report count. Global admin only. */
  @UseGuards(NginxAuthGuard)
  @Get('hidden')
  getHiddenPosts(@Headers('x-global-admin') xGlobalAdmin: string | undefined) {
    if (xGlobalAdmin !== 'true') throw new UnauthorizedException('Global admin required');
    return this.service.getHiddenPosts();
  }

  /** Returns posts matching the given search query. */
  @Get('search')
  searchPosts(
    @Query('q') q: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string
  ) {
    return this.service.searchPosts(q ?? '', Number(limit ?? 20), Number(offset ?? 0));
  }

  /** Returns a paginated list of posts for the requested feed. */
  @Get()
  listPosts(
    @Query() query: ListPostsQueryDto,
    @Headers('x-user-id') xUserId?: string,
    @Headers('x-global-admin') xGlobalAdmin?: string
  ) {
    const feed = query.feed ?? 'all';
    if (feed === 'followed' && !xUserId) {
      throw new UnauthorizedException('Authentication required for followed feed');
    }
    return this.service.listPosts({
      limit: query.limit ?? 30,
      offset: query.offset ?? 0,
      feed,
      viewerUserId: xUserId,
      isAdmin: xGlobalAdmin === 'true',
      promo: query.promo,
      formation: query.formation?.trim() || undefined,
    });
  }

  // ── User follows (under /api/posts/users/:userId/follow) ─────────────────

  /** Follows a user. */
  @UseGuards(NginxAuthGuard)
  @HttpPost('users/:userId/follow')
  followUser(@Headers('x-user-id') xUserId: string, @Param('userId') userId: string) {
    if (userId === xUserId) throw new BadRequestException('Cannot follow yourself');
    return this.followsService.followUser(xUserId, userId);
  }

  /** Unfollows a user. */
  @UseGuards(NginxAuthGuard)
  @Delete('users/:userId/follow')
  unfollowUser(@Headers('x-user-id') xUserId: string, @Param('userId') userId: string) {
    return this.followsService.unfollowUser(xUserId, userId);
  }

  /** Returns whether the calling user follows the given user. */
  @UseGuards(NginxAuthGuard)
  @Get('users/:userId/follow-status')
  getUserFollowStatus(@Headers('x-user-id') xUserId: string, @Param('userId') userId: string) {
    return this.followsService
      .isFollowingUser(xUserId, userId)
      .then((following) => ({ following }));
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
    if (body.associationId) {
      const canPost = await this.associationsService.canPostAs(xUserId, body.associationId, {
        isGlobalAdmin: xGlobalAdmin === 'true',
      });
      if (!canPost) {
        throw new BadRequestException('You need admin or owner role to post as this association');
      }
    }
    if (body.paymentAssociationId) {
      // Honors approved parent-payment delegation: a club with no own account but a ready parent passes.
      if (!(await this.associationsService.isStripePaymentsReady(body.paymentAssociationId))) {
        throw new BadRequestException('This association has not completed Stripe onboarding');
      }
    }
    return this.service.createPost({ ...body, authorId: xUserId });
  }

  /** Association agenda entry linked to this post (same association), if configured. */
  @Get(':postId/calendar-link')
  async getPostCalendarLink(@Param('postId') postId: string) {
    const linkedEvent = await this.associationsService.findCalendarEventByLinkedPost(postId);
    return { linkedEvent };
  }

  /** Returns a single post by its ID. Global admins may load moderation-hidden posts. */
  @Get(':postId')
  getPost(@Param('postId') postId: string, @Headers('x-global-admin') xGlobalAdmin?: string) {
    return this.service.getById(postId, { allowHidden: xGlobalAdmin === 'true' });
  }

  /** Updates a post's content. Author or global admin may edit. */
  @UseGuards(NginxAuthGuard)
  @Patch(':postId')
  updatePost(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') ga: string,
    @Param('postId') postId: string,
    @Body() body: UpdatePostDto
  ) {
    return this.service.updatePost(postId, xUserId, body, ga === 'true');
  }

  /** Deletes a post; global admins may delete any post. */
  @UseGuards(NginxAuthGuard)
  @Delete(':postId')
  deletePost(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Param('postId') postId: string
  ) {
    return this.service.deletePost(postId, xUserId, xGlobalAdmin === 'true');
  }

  /** Records a vote for the calling user on the specified poll option. */
  @UseGuards(NginxAuthGuard)
  @HttpPost(':postId/polls/:pollId/vote')
  votePoll(
    @Headers('x-user-id') xUserId: string,
    @Param('postId') postId: string,
    @Param('pollId') pollId: string,
    @Body() body: VotePollDto
  ) {
    return this.interactions.votePoll(postId, pollId, { ...body, userId: xUserId });
  }

  /** Submits the embedded form on a post. */
  @UseGuards(NginxAuthGuard)
  @HttpPost(':postId/forms/:formId/submit')
  submitForm(
    @Headers('x-user-id') xUserId: string,
    @Param('postId') postId: string,
    @Param('formId') formId: string,
    @Body() body: SubmitFormDto
  ) {
    return this.interactions.submitForm(postId, formId, { ...body, userId: xUserId });
  }

  /** Adds an emoji reaction from the calling user to a post. */
  @UseGuards(NginxAuthGuard)
  @HttpPost(':postId/reactions')
  async addReaction(
    @Headers('x-user-id') xUserId: string,
    @Param('postId') postId: string,
    @Body() body: AddReactionDto
  ) {
    await this.assertNotMuted(xUserId);
    return this.interactions.addReaction(postId, xUserId, body.reactionType);
  }

  /** Removes the calling user's reaction from a post. */
  @UseGuards(NginxAuthGuard)
  @Delete(':postId/reactions')
  removeReaction(@Headers('x-user-id') xUserId: string, @Param('postId') postId: string) {
    return this.interactions.removeReaction(postId, xUserId);
  }

  /** Adds a comment from the calling user to a post. */
  @UseGuards(NginxAuthGuard)
  @HttpPost(':postId/comments')
  async addComment(
    @Headers('x-user-id') xUserId: string,
    @Param('postId') postId: string,
    @Body() body: AddCommentDto
  ) {
    await this.assertNotMuted(xUserId);
    return this.interactions.addComment(postId, { ...body, userId: xUserId });
  }

  /** Toggles a like from the calling user on a specific comment. */
  @UseGuards(NginxAuthGuard)
  @HttpPost(':postId/comments/:commentId/like')
  likeComment(
    @Headers('x-user-id') xUserId: string,
    @Param('postId') postId: string,
    @Param('commentId') commentId: string
  ) {
    return this.interactions.likeComment(postId, commentId, xUserId);
  }

  /** Updates the text of a comment owned by the calling user. */
  @UseGuards(NginxAuthGuard)
  @Patch(':postId/comments/:commentId')
  editComment(
    @Headers('x-user-id') xUserId: string,
    @Param('postId') postId: string,
    @Param('commentId') commentId: string,
    @Body() body: EditCommentDto
  ) {
    return this.interactions.editComment(postId, commentId, xUserId, body.text);
  }

  /** Deletes a comment; the author or a global admin may delete. */
  @UseGuards(NginxAuthGuard)
  @Delete(':postId/comments/:commentId')
  deleteComment(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Param('postId') postId: string,
    @Param('commentId') commentId: string
  ) {
    return this.interactions.deleteComment(postId, commentId, xUserId, xGlobalAdmin === 'true');
  }

  /** Pins a post; requires global admin privileges. */
  @UseGuards(NginxAuthGuard)
  @Patch(':postId/pin')
  pinPost(
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Param('postId') postId: string
  ) {
    if (xGlobalAdmin !== 'true') throw new UnauthorizedException('Global admin required');
    return this.service.setPinned(postId, true);
  }

  /** Unpins a post; requires global admin privileges. */
  @UseGuards(NginxAuthGuard)
  @Patch(':postId/unpin')
  unpinPost(
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Param('postId') postId: string
  ) {
    if (xGlobalAdmin !== 'true') throw new UnauthorizedException('Global admin required');
    return this.service.setPinned(postId, false);
  }

  /** Hides a post from public feeds (moderation). Global admin only. */
  @UseGuards(NginxAuthGuard)
  @Patch(':postId/hide')
  hidePost(
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Param('postId') postId: string
  ) {
    if (xGlobalAdmin !== 'true') throw new UnauthorizedException('Global admin required');
    return this.service.hidePostByModeration(postId);
  }

  /** Restores a moderation-hidden post back to the public feed. Global admin only. */
  @UseGuards(NginxAuthGuard)
  @Patch(':postId/unhide')
  unhidePost(
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Param('postId') postId: string
  ) {
    if (xGlobalAdmin !== 'true') throw new UnauthorizedException('Global admin required');
    return this.service.unhidePost(postId);
  }

  /** Submits a report for a post from the calling user. */
  @UseGuards(NginxAuthGuard)
  @HttpPost(':postId/report')
  reportPost(
    @Headers('x-user-id') xUserId: string,
    @Param('postId') postId: string,
    @Body() body: ReportPostDto
  ) {
    return this.service.reportPost(postId, xUserId, body.reason);
  }
}
