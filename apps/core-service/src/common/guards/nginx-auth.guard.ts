import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

/** Guard that verifies the request was forwarded by nginx with a valid X-User-Id header. */
@Injectable()
export class NginxAuthGuard implements CanActivate {
  /** Returns true when X-User-Id is present; throws UnauthorizedException otherwise. */
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const userId = (request.headers['x-user-id'] as string | undefined)
      ?.trim()
      .toLowerCase();
    if (!userId) {
      throw new UnauthorizedException(
        'Missing X-User-Id header - ensure the request passes through nginx auth.',
      );
    }
    return true;
  }
}
