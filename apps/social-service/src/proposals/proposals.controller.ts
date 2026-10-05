import {
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post as HttpPost,
  UseGuards,
} from '@nestjs/common';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { ProposalsService } from './proposals.service';

/**
 * Proposals between associations, whatever their kind, under `/api/associations/...` - the prefix
 * nginx already routes here. No route below collides with `AssociationsController`'s: the queue is
 * `:id/proposals`, a literal it does not use, and the decisions start with the literal `proposals`
 * followed by an id and a verb, a shape it has none of.
 */
@Controller('associations')
@UseGuards(NginxAuthGuard)
export class ProposalsController {
  constructor(private readonly proposals: ProposalsService) {}

  /** The pending proposals the caller may act on, received and sent, for one association. */
  @Get(':id/proposals')
  listPending(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Param('id', ParseUUIDPipe) associationId: string
  ) {
    return this.proposals.listPending(associationId, xUserId, xGlobalAdmin === 'true');
  }

  @HttpPost('proposals/:proposalId/accept')
  accept(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Param('proposalId', ParseUUIDPipe) proposalId: string
  ) {
    return this.proposals.accept(proposalId, xUserId, xGlobalAdmin === 'true');
  }

  @HttpPost('proposals/:proposalId/refuse')
  refuse(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Param('proposalId', ParseUUIDPipe) proposalId: string
  ) {
    return this.proposals.refuse(proposalId, xUserId, xGlobalAdmin === 'true');
  }

  @HttpPost('proposals/:proposalId/withdraw')
  withdraw(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Param('proposalId', ParseUUIDPipe) proposalId: string
  ) {
    return this.proposals.withdraw(proposalId, xUserId, xGlobalAdmin === 'true');
  }
}
