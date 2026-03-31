import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Guard that checks the `X-Global-Admin` header is `"true"`.
 *
 * This header is set by nginx after the auth_request sub-request,
 * which extracts it from the JWT `admin` claim in core-service's
 * verify endpoint. It must never be accepted from untrusted clients.
 *
 * Always pair with NginxAuthGuard to ensure X-User-Id is present.
 */
@Injectable()
export class GlobalAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const isAdmin = request.headers['x-global-admin'] === 'true';
    if (!isAdmin) {
      throw new ForbiddenException('This action requires global admin privileges');
    }
    return true;
  }
}
