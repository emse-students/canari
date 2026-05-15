import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Guard that checks the `X-Global-Admin` header is `"true"`.
 * This header is injected by nginx from the JWT `admin` claim.
 * Always pair with NginxAuthGuard.
 */
@Injectable()
export class GlobalAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (request.headers['x-global-admin'] !== 'true') {
      throw new ForbiddenException('This action requires global admin privileges');
    }
    return true;
  }
}
