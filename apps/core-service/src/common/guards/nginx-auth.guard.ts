import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

@Injectable()
export class NginxAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const userId = (request.headers['x-user-id'] as string | undefined)
      ?.trim()
      .toLowerCase();
    if (!userId) {
      throw new UnauthorizedException(
        'Missing X-User-Id header — ensure the request passes through nginx auth.',
      );
    }
    return true;
  }
}
