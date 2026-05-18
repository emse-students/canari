import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AssociationMember, AssociationPermissionFlag } from '../entities/association-member.entity';

/** Metadata key used with `@SetMetadata` to declare the required permission flag. */
export const PERM_FLAG_KEY = 'association_perm_flag';

/**
 * Guard that checks the caller holds the required `AssociationPermissionFlag`
 * in the association identified by the `:id` route parameter.
 *
 * Usage:
 *   @SetMetadata(PERM_FLAG_KEY, AssociationPermissionFlag.MANAGE_MEMBERS)
 *   @UseGuards(NginxAuthGuard, AssociationRoleGuard)
 */
@Injectable()
export class AssociationRoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectRepository(AssociationMember)
    private readonly memberRepo: Repository<AssociationMember>
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredFlag =
      this.reflector.get<AssociationPermissionFlag>(PERM_FLAG_KEY, context.getHandler()) ?? 0;

    const request = context.switchToHttp().getRequest();
    const userId = (request.headers['x-user-id'] as string | undefined)?.trim();
    const associationId = request.params?.id;

    if (!userId || !associationId) {
      throw new ForbiddenException('Missing user or association context');
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
