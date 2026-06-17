import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AssociationMember,
  AssociationPermissionFlag,
} from '../entities/association-member.entity';
import { PERM_FLAG_KEY } from './association-role.guard';
import { AssociationsService } from '../associations.service';

/**
 * Allows the request if `X-Global-Admin` is true or the caller is a cross-association
 * super-admin (BDE member with `MANAGE_ASSO`), else requires association membership
 * with the flag declared via `@SetMetadata(PERM_FLAG_KEY, ...)` (default: 0 = any member).
 */
@Injectable()
export class GlobalAdminOrAssociationRoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectRepository(AssociationMember)
    private readonly memberRepo: Repository<AssociationMember>,
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

    if (request.headers['x-global-admin'] === 'true') {
      return true;
    }

    // BDE super-admin (MANAGE_ASSO) administers any association like a global admin.
    if (await this.associationsService.isAssociationSuperAdmin(userId)) {
      return true;
    }

    const membership = await this.memberRepo.findOne({
      where: { associationId, userId },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this association');
    }

    if (requiredFlag !== 0 && (membership.permissions & requiredFlag) === 0) {
      throw new ForbiddenException('Insufficient permissions in this association');
    }

    return true;
  }
}
