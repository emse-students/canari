import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AssociationsService } from '../associations.service';

/**
 * Allows the request for anyone entitled to review associations' public documents:
 * platform global admins, BDE super-admins (`MANAGE_ASSO`), or users holding a
 * global document-reviewer grant. Gates the cross-association reviewer read routes.
 */
@Injectable()
export class ReviewerAccessGuard implements CanActivate {
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
    if (await this.associationsService.isDocumentReviewer(userId)) {
      return true;
    }
    throw new ForbiddenException('Document reviewer access required');
  }
}
