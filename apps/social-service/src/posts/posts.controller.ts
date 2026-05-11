import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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
import {
  CreatePostDto,
  ListPostsQueryDto,
  RegisterEventDto,
  VotePollDto,
  AddCommentDto,
  AddReactionDto,
  EditCommentDto,
  UpdatePostDto,
  ReportPostDto,
} from './dto/post.dto';

@Controller('posts')
export class PostsController {
  constructor(
    private readonly service: PostsService,
    private readonly interactions: PostInteractionsService,
    private readonly notifications: PostNotificationsService,
    private readonly associationsService: AssociationsService
  ) {}

  @Get('health')
  health() {
    return { service: 'post-service', status: 'ok', timestamp: new Date().toISOString() };
  }

  @UseGuards(NginxAuthGuard)
  @Get('notifications')
  getNotifications(@Headers('x-user-id') xUserId: string, @Query('limit') limit?: string) {
    return this.notifications.getNotifications(xUserId, Number(limit ?? 30));
  }

  @UseGuards(NginxAuthGuard)
  @HttpPost('notifications/read-all')
  markAllRead(@Headers('x-user-id') xUserId: string) {
    return this.notifications.markAllRead(xUserId);
  }

  @UseGuards(NginxAuthGuard)
  @Get('my-scheduled')
  getMyScheduledPosts(@Headers('x-user-id') xUserId: string) {
    return this.service.getMyScheduledPosts(xUserId);
  }

  @Get('search')
  searchPosts(
    @Query('q') q: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string
  ) {
    return this.service.searchPosts(q ?? '', Number(limit ?? 20), Number(offset ?? 0));
  }

  @Get()
  listPosts(@Query() query: ListPostsQueryDto, @Headers('x-user-id') xUserId?: string) {
    const feed = query.feed ?? 'all';
    if (feed === 'followed' && !xUserId) {
      throw new UnauthorizedException('Authentication required for followed feed');
    }
    return this.service.listPosts({
      limit: query.limit ?? 30,
      offset: query.offset ?? 0,
      feed,
      viewerUserId: xUserId,
      promo: query.promo,
      formation: query.formation?.trim() || undefined,
    });
  }

  @UseGuards(NginxAuthGuard)
  @HttpPost()
  async createPost(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Body() body: CreatePostDto
  ) {
    if (body.associationId) {
      const canPost = await this.associationsService.canPostAs(xUserId, body.associationId, {
        isGlobalAdmin: xGlobalAdmin === 'true',
      });
      if (!canPost) {
        throw new BadRequestException('You need admin or owner role to post as this association');
      }
    }
    if (body.paymentAssociationId) {
      const asso = await this.associationsService.findById(body.paymentAssociationId);
      if (!asso.stripeOnboardingComplete) {
        throw new BadRequestException('This association has not completed Stripe onboarding');
      }
    }
    return this.service.createPost({ ...body, authorId: xUserId });
  }

  @Get(':postId')
  getPost(@Param('postId') postId: string) {
    return this.service.getById(postId);
  }

  @UseGuards(NginxAuthGuard)
  @Patch(':postId')
  updatePost(
    @Headers('x-user-id') xUserId: string,
    @Param('postId') postId: string,
    @Body() body: UpdatePostDto
  ) {
    return this.service.updatePost(postId, xUserId, body.markdown);
  }

  @UseGuards(NginxAuthGuard)
  @Delete(':postId')
  deletePost(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Param('postId') postId: string
  ) {
    return this.service.deletePost(postId, xUserId, xGlobalAdmin === 'true');
  }

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

  @UseGuards(NginxAuthGuard)
  @HttpPost(':postId/events/:buttonId/register')
  registerEvent(
    @Headers('x-user-id') xUserId: string,
    @Param('postId') postId: string,
    @Param('buttonId') buttonId: string,
    @Body() body: RegisterEventDto
  ) {
    return this.interactions.registerEvent(postId, buttonId, { ...body, userId: xUserId });
  }

  @UseGuards(NginxAuthGuard)
  @HttpPost(':postId/forms/:formId/submit')
  submitForm(@Param('postId') postId: string) {
    return this.interactions.submitForm(postId);
  }

  @UseGuards(NginxAuthGuard)
  @HttpPost(':postId/reactions')
  addReaction(
    @Headers('x-user-id') xUserId: string,
    @Param('postId') postId: string,
    @Body() body: AddReactionDto
  ) {
    return this.interactions.addReaction(postId, xUserId, body.reactionType);
  }

  @UseGuards(NginxAuthGuard)
  @Delete(':postId/reactions')
  removeReaction(@Headers('x-user-id') xUserId: string, @Param('postId') postId: string) {
    return this.interactions.removeReaction(postId, xUserId);
  }

  @UseGuards(NginxAuthGuard)
  @HttpPost(':postId/comments')
  addComment(
    @Headers('x-user-id') xUserId: string,
    @Param('postId') postId: string,
    @Body() body: AddCommentDto
  ) {
    return this.interactions.addComment(postId, { ...body, userId: xUserId });
  }

  @UseGuards(NginxAuthGuard)
  @HttpPost(':postId/comments/:commentId/like')
  likeComment(
    @Headers('x-user-id') xUserId: string,
    @Param('postId') postId: string,
    @Param('commentId') commentId: string
  ) {
    return this.interactions.likeComment(postId, commentId, xUserId);
  }

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

  @UseGuards(NginxAuthGuard)
  @Delete(':postId/comments/:commentId')
  deleteComment(
    @Headers('x-user-id') xUserId: string,
    @Param('postId') postId: string,
    @Param('commentId') commentId: string
  ) {
    return this.interactions.deleteComment(postId, commentId, xUserId);
  }

  @UseGuards(NginxAuthGuard)
  @Patch(':postId/pin')
  pinPost(
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Param('postId') postId: string
  ) {
    if (xGlobalAdmin !== 'true') throw new UnauthorizedException('Global admin required');
    return this.service.setPinned(postId, true);
  }

  @UseGuards(NginxAuthGuard)
  @Patch(':postId/unpin')
  unpinPost(
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Param('postId') postId: string
  ) {
    if (xGlobalAdmin !== 'true') throw new UnauthorizedException('Global admin required');
    return this.service.setPinned(postId, false);
  }

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
