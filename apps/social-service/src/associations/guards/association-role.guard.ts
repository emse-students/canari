import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AssociationMember, type AssociationRole } from '../entities/association-member.entity';

export const ROLE_HIERARCHY: Record<AssociationRole, number> = {
  member: 0,
  admin: 1,
  owner: 2,
};

export const MIN_ROLE_KEY = 'association_min_role';

/**
 * Guard that checks the caller has at least `minRole` in the association
 * identified by the `:id` route parameter.
 *
 * Usage:
 *   @SetMetadata(MIN_ROLE_KEY, 'admin')
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
    const minRole =
      this.reflector.get<AssociationRole>(MIN_ROLE_KEY, context.getHandler()) ?? 'member';

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

    if (ROLE_HIERARCHY[membership.role] < ROLE_HIERARCHY[minRole]) {
      throw new ForbiddenException(`Requires at least ${minRole} role in this association`);
    }

    return true;
  }
}
