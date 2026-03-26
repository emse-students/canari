import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Validates that the `X-User-Id` header is present on the request.
 *
 * This header is injected by nginx after a successful `auth_request`
 * sub-request, so its presence guarantees the caller is authenticated.
 * It must never be accepted from untrusted clients directly.
 */
@Injectable()
export class NginxAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const userId = (request.headers['x-user-id'] as string | undefined)?.trim().toLowerCase();
    if (!userId) {
      throw new UnauthorizedException(
        'Missing X-User-Id header — ensure the request passes through nginx auth.'
      );
    }
    return true;
  }
}
