import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AssociationMember, AssociationPermission } from '../entities/association-member.entity';

export const MIN_ROLE_KEY = 'association_min_permission';

/**
 * Guard that checks the caller has at least `minPermission` in the association
 * identified by the `:id` route parameter.
 *
 * Usage:
 *   @SetMetadata(MIN_ROLE_KEY, AssociationPermission.Admin)
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
    const minPermission =
      this.reflector.get<AssociationPermission>(MIN_ROLE_KEY, context.getHandler()) ??
      AssociationPermission.Member;

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

    if (membership.permission < minPermission) {
      throw new ForbiddenException('Insufficient permissions in this association');
    }

    return true;
  }
}
