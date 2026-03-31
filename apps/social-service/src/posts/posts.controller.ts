import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post as HttpPost,
  Query,
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
  async createPost(@Headers('x-user-id') xUserId: string, @Body() body: CreatePostDto) {
    // Validate association authorship
    if (body.associationId) {
      const canPost = await this.associationsService.canPostAs(xUserId, body.associationId);
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

  @Get()
  listPosts(@Query() query: ListPostsQueryDto) {
    const limit = query.limit || 30;
    const offset = query.offset || 0;
    return this.service.listPosts(limit, offset);
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
}
