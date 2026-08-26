import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AssociationPermissionFlag } from '../entities/association-member.entity';
import { AssociationsService } from '../associations.service';

/**
 * Metadata key naming the `AssociationPermissionFlag` a route requires.
 *
 * Usage:
 *   @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_MEMBERS)
 *   @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
 *
 * Omit it and the route asks for membership alone.
 */
export const PERM_FLAG_KEY = 'association_perm_flag';

/**
 * Gates an association-scoped route on the flag declared via `@SetMetadata(PERM_FLAG_KEY, ...)`.
 *
 * It holds no policy of its own: the flag question goes to `AssociationsService.mayAct`, the one
 * predicate that knows the platform administrator and the cross-association super-admin sit above
 * an association's own bitmask. A route declaring no flag (the default 0) asks only for
 * membership, which is a different question and is answered here.
 */
@Injectable()
export class GlobalAdminOrAssociationRoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly associationsService: AssociationsService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredFlag =
      this.reflector.get<AssociationPermissionFlag>(PERM_FLAG_KEY, context.getHandler()) ?? 0;

    const request = context.switchToHttp().getRequest();
    const userId = (request.headers['x-user-id'] as string | undefined)?.trim();
    const associationId = request.params?.id as string | undefined;

    if (!userId || !associationId) {
      throw new ForbiddenException('Missing user or association context');
    }

    const isGlobalAdmin = request.headers['x-global-admin'] === 'true';

    if (requiredFlag === 0) {
      if (isGlobalAdmin) return true;
      if (await this.associationsService.isAssociationSuperAdmin(userId)) return true;
      if (await this.associationsService.isMember(userId, associationId)) return true;
      throw new ForbiddenException('You are not a member of this association');
    }

    if (
      await this.associationsService.mayAct(userId, associationId, requiredFlag, { isGlobalAdmin })
    ) {
      return true;
    }

    // Two causes, two messages: a stranger to the association and a member missing one right are
    // different problems, and a single sentence for both sends the reader after the wrong one.
    if (!(await this.associationsService.isMember(userId, associationId))) {
      throw new ForbiddenException('You are not a member of this association');
    }
    throw new ForbiddenException('Insufficient permissions in this association');
  }
}
