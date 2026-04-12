import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Validates that the `X-User-Id` header is present on the request.
 *
 * In production, this header is injected by nginx after a successful
 * `auth_request` sub-request, so its presence guarantees the caller is
 * authenticated. It must never be accepted from untrusted clients directly.
 *
 * In non-production environments (local dev without nginx), the guard falls
 * back to decoding the JWT Bearer token and extracting the `sub` claim as
 * the user identity, then forwards it as `x-user-id` so downstream code
 * behaves identically.
 */
@Injectable()
export class NginxAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const userId = (request.headers['x-user-id'] as string | undefined)?.trim().toLowerCase();

    // En production, on peut exiger un header secret injecté par Nginx
    // lorsque NGINX_AUTH_SECRET est configuré.
    if (process.env.NODE_ENV === 'production') {
      const expectedNginxSecret = process.env.NGINX_AUTH_SECRET?.trim();
      if (expectedNginxSecret) {
        const nginxSecret = request.headers['x-nginx-auth'] as string | undefined;
        if (!nginxSecret || nginxSecret !== expectedNginxSecret) {
          throw new UnauthorizedException(
            'Requête non autorisée : header Nginx manquant ou invalide.'
          );
        }
      }
      if (userId) {
        return true;
      }
      throw new UnauthorizedException(
        'Missing X-User-Id header — ensure the request passes through nginx auth.'
      );
    }

    // Dev fallback: nginx n'est pas présent, on extrait le userId du JWT
    if (userId) {
      return true;
    }
    const authHeader = request.headers['authorization'] as string | undefined;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const parts = token.split('.');
      if (parts.length === 3) {
        try {
          const payload = JSON.parse(
            Buffer.from(parts[1], 'base64url').toString('utf-8')
          ) as Record<string, unknown>;
          const sub = typeof payload.sub === 'string' ? payload.sub.trim() : null;
          if (sub) {
            request.headers['x-user-id'] = sub;
            return true;
          }
        } catch {
          // Malformed token — fall through to UnauthorizedException
        }
      }
    }
    throw new UnauthorizedException(
      'Missing X-User-Id header or JWT — ensure the request passes through nginx auth.'
    );
  }
}
