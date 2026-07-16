import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AssociationsService } from '../associations.service';

/**
 * Allows the request only for platform global admins (`X-Global-Admin: true`) or
 * BDE super-admins (a member of a BDE association holding `MANAGE_ASSO`). Used for
 * cross-association routes that carry no `:id` param (e.g. managing the global
 * document-reviewer grants).
 */
@Injectable()
export class GlobalAdminOrBdeSuperAdminGuard implements CanActivate {
  constructor(private readonly associationsService: AssociationsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const userId = (request.headers['x-user-id'] as string | undefined)?.trim();
    if (!userId) {
      throw new ForbiddenException('Missing user context');
    }
    if (request.headers['x-global-admin'] === 'true') {
      return true;
    }
    if (await this.associationsService.isAssociationSuperAdmin(userId)) {
      return true;
    }
    throw new ForbiddenException('Global admin or BDE super-admin required');
  }
}
