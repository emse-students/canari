import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { AppService } from './app.service';

@Controller('auth')
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('health')
  health(): string {
    return 'OK';
  }

  @Post('token')
  getToken(@Body() body: { userId?: string }): { token: string } {
    const userId = body?.userId?.trim()?.toLowerCase();
    if (!userId) {
      throw new BadRequestException('userId is required');
    }
    return this.appService.generateToken(userId);
  }
}
