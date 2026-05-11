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
import { AssociationsService } from '../associations/associations.service';
import {
  CreatePostDto,
  ListPostsQueryDto,
  RegisterEventDto,
  VotePollDto,
  SubmitFormDto,
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
    private readonly associationsService: AssociationsService
  ) {}

  @Get('health')
  health() {
    return {
      service: 'post-service',
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  @UseGuards(NginxAuthGuard)
  @HttpPost()
  async createPost(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Body() body: CreatePostDto
  ) {
    // Validate association authorship (association admin, or global admin)
    if (body.associationId) {
      const canPost = await this.associationsService.canPostAs(xUserId, body.associationId, {
        isGlobalAdmin: xGlobalAdmin === 'true',
      });
      if (!canPost) {
        throw new BadRequestException('You need admin or owner role to post as this association');
      }
    }

    // Validate payment association has completed Stripe onboarding
    if (body.paymentAssociationId) {
      const asso = await this.associationsService.findById(body.paymentAssociationId);
      if (!asso.stripeOnboardingComplete) {
        throw new BadRequestException('This association has not completed Stripe onboarding');
      }
    }

    return this.service.createPost({ ...body, authorId: xUserId });
  }

  @Get('search')
  searchPosts(
    @Query('q') q: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string
  ) {
    return this.service.searchPosts(q ?? '', Number(limit ?? 20), Number(offset ?? 0));
  }

  @UseGuards(NginxAuthGuard)
  @Get('notifications')
  getNotifications(
    @Headers('x-user-id') xUserId: string,
    @Query('limit') limit?: string
  ) {
    return this.service.getNotifications(xUserId, Number(limit ?? 30));
  }

  @UseGuards(NginxAuthGuard)
  @HttpPost('notifications/read-all')
  markAllRead(@Headers('x-user-id') xUserId: string) {
    return this.service.markAllNotificationsRead(xUserId);
  }

  @UseGuards(NginxAuthGuard)
  @Get('my-scheduled')
  getMyScheduledPosts(@Headers('x-user-id') xUserId: string) {
    return this.service.getMyScheduledPosts(xUserId);
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
  @HttpPost(':postId/polls/:pollId/vote')
  votePoll(
    @Headers('x-user-id') xUserId: string,
    @Param('postId') postId: string,
    @Param('pollId') pollId: string,
    @Body() body: VotePollDto
  ) {
    return this.service.votePoll(postId, pollId, { ...body, userId: xUserId });
  }

  @UseGuards(NginxAuthGuard)
  @HttpPost(':postId/events/:buttonId/register')
  registerEvent(
    @Headers('x-user-id') xUserId: string,
    @Param('postId') postId: string,
    @Param('buttonId') buttonId: string,
    @Body() body: RegisterEventDto
  ) {
    return this.service.registerEvent(postId, buttonId, { ...body, userId: xUserId });
  }

  @UseGuards(NginxAuthGuard)
  @HttpPost(':postId/forms/:formId/submit')
  submitForm(
    @Headers('x-user-id') xUserId: string,
    @Param('postId') postId: string,
    @Param('formId') formId: string,
    @Body() body: SubmitFormDto
  ) {
    return this.service.submitForm(postId, formId, { ...body, userId: xUserId });
  }

  @UseGuards(NginxAuthGuard)
  @HttpPost(':postId/reactions')
  addReaction(
    @Headers('x-user-id') xUserId: string,
    @Param('postId') postId: string,
    @Body() body: AddReactionDto
  ) {
    return this.service.addReaction(postId, xUserId, body.reactionType);
  }

  @UseGuards(NginxAuthGuard)
  @Delete(':postId/reactions')
  removeReaction(@Headers('x-user-id') xUserId: string, @Param('postId') postId: string) {
    return this.service.removeReaction(postId, xUserId);
  }

  @UseGuards(NginxAuthGuard)
  @HttpPost(':postId/comments')
  addComment(
    @Headers('x-user-id') xUserId: string,
    @Param('postId') postId: string,
    @Body() body: AddCommentDto
  ) {
    return this.service.addComment(postId, { ...body, userId: xUserId });
  }

  @UseGuards(NginxAuthGuard)
  @HttpPost(':postId/comments/:commentId/like')
  likeComment(
    @Headers('x-user-id') xUserId: string,
    @Param('postId') postId: string,
    @Param('commentId') commentId: string
  ) {
    return this.service.likeComment(postId, commentId, xUserId);
  }

  @UseGuards(NginxAuthGuard)
  @Patch(':postId/comments/:commentId')
  editComment(
    @Headers('x-user-id') xUserId: string,
    @Param('postId') postId: string,
    @Param('commentId') commentId: string,
    @Body() body: EditCommentDto
  ) {
    return this.service.editComment(postId, commentId, xUserId, body.text);
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

  @UseGuards(NginxAuthGuard)
  @Delete(':postId/comments/:commentId')
  deleteComment(
    @Headers('x-user-id') xUserId: string,
    @Param('postId') postId: string,
    @Param('commentId') commentId: string
  ) {
    return this.service.deleteComment(postId, commentId, xUserId);
  }
}
