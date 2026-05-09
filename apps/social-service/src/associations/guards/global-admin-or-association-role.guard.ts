import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AssociationMember, AssociationPermission } from '../entities/association-member.entity';
import { MIN_ROLE_KEY } from './association-role.guard';

/**
 * Allows the request if `X-Global-Admin` is true, else requires association membership
 * with at least `MIN_ROLE_KEY` (default: Member — set Admin on the handler).
 */
@Injectable()
export class GlobalAdminOrAssociationRoleGuard implements CanActivate {
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
    const associationId = request.params?.id as string | undefined;

    if (!userId || !associationId) {
      throw new ForbiddenException('Missing user or association context');
    }

    if (request.headers['x-global-admin'] === 'true') {
      return true;
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
