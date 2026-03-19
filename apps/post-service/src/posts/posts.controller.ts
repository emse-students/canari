import { Body, Controller, Get, Param, Post as HttpPost, Query } from '@nestjs/common';
import { PostsService } from './posts.service';
import { CreatePostDto, ListPostsQueryDto, RegisterEventDto, VotePollDto } from './dto/post.dto';

@Controller('posts')
export class PostsController {
  constructor(private readonly service: PostsService) {}

  @Get('health')
  health() {
    return {
      service: 'post-service',
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  @HttpPost()
  createPost(@Body() body: CreatePostDto) {
    return this.service.createPost(body);
  }

  @Get()
  listPosts(@Query() query: ListPostsQueryDto) {
    const limit = query.limit || 30;
    const offset = query.offset || 0;
    return this.service.listPosts(limit, offset);
  }

  @HttpPost(':postId/polls/:pollId/vote')
  votePoll(
    @Param('postId') postId: string,
    @Param('pollId') pollId: string,
    @Body() body: VotePollDto
  ) {
    return this.service.votePoll(postId, pollId, body);
  }

  @HttpPost(':postId/events/:buttonId/register')
  registerEvent(
    @Param('postId') postId: string,
    @Param('buttonId') buttonId: string,
    @Body() body: RegisterEventDto
  ) {
    return this.service.registerEvent(postId, buttonId, body);
  }
}
