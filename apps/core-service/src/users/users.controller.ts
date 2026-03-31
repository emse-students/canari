import {
  Controller,
  Get,
  Body,
  Patch,
  Param,
  Headers,
  UseGuards,
  Req,
  Query,
  Post,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/user.dto';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';

interface JwtUser {
  sub?: string;
  id?: string;
}

interface RequestWithUser {
  user?: JwtUser;
}

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /**
   * Search users by id or displayName for autocomplete.
   * Usage: GET /users/search?q=jol
   */
  @Get('search')
  search(@Query('q') query: string, @Req() req: RequestWithUser) {
    // Exclude current user from results if authenticated
    const currentUserId = req.user?.sub || req.user?.id;
    return this.usersService.search(query, currentUserId);
  }

  @Post()
  create(@Body() createUserDto: CreateUserDto) {
    return this.usersService.create(createUserDto);
  }
  
  @UseGuards(NginxAuthGuard)
  @Get('me')
  async getMe(@Headers('x-user-id') userId: string) {
    const user = await this.usersService.findOne(userId);
    return this.usersService.toPublicDto(user);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const user = await this.usersService.findOne(id);
    return this.usersService.toPublicDto(user);
  }

  @UseGuards(NginxAuthGuard)
  @Patch('me')
  async updateMe(
    @Headers('x-user-id') userId: string,
    @Body() updateUserDto: UpdateUserDto,
  ) {
    const user = await this.usersService.update(userId, updateUserDto);
    return this.usersService.toPublicDto(user);
  }
}
