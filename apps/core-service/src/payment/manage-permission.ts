import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
  type Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import axios from 'axios';
import { socialUrl } from '../internal/service-urls';

/**
 * Refuses unless the caller may manage the payout account of `associationId` (social-service's
 * `manage-permission`, MANAGE_PAYOUT_ACCOUNT): 401 without a user, 403 when refused, 400 when the
 * check itself could not be made. The caller's identity headers are forwarded as nginx set them.
 * Shared by every core route a payout manager calls (`PaymentController`, `LydiaCashiersController`).
 */
export async function assertCanManageAssociation(
  req: Request,
  associationId: string,
  logger: Logger,
  /** A bound on social-service's answer; the onboarding passes its step budget, others none. */
  timeoutMs?: number
): Promise<void> {
  const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
  if (!userId) {
    throw new UnauthorizedException('Authentication required');
  }
  const fwd: Record<string, string> = {
    'X-User-Id': userId,
    'X-Global-Admin': req.headers['x-global-admin'] === 'true' ? 'true' : 'false',
  };
  const nginxAuth = req.headers['x-nginx-auth'];
  if (typeof nginxAuth === 'string') fwd['X-Nginx-Auth'] = nginxAuth;
  const authz = req.headers['authorization'];
  if (typeof authz === 'string') fwd['Authorization'] = authz;
  // Forward the Nginx-generated HMAC token so social-service's NginxAuthGuard
  // can validate the inter-service call when INTERNAL_SHARED_SECRET is configured.
  const internalToken = req.headers['x-internal-token'];
  if (typeof internalToken === 'string') fwd['X-Internal-Token'] = internalToken;

  try {
    const res = await axios.get<{ ok: boolean }>(
      socialUrl(`associations/${encodeURIComponent(associationId)}/manage-permission`),
      { headers: fwd, validateStatus: () => true, timeout: timeoutMs }
    );
    if (res.status >= 400 || !res.data?.ok) {
      throw new ForbiddenException('You cannot manage payments for this association');
    }
  } catch (e) {
    if (e instanceof ForbiddenException || e instanceof UnauthorizedException) throw e;
    logger.warn(`manage-permission check failed: ${e instanceof Error ? e.message : String(e)}`);
    throw new BadRequestException('Could not verify association permissions');
  }
}
