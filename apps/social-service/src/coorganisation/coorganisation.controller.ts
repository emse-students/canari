import { Controller, Get, Headers, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { CoorganisationService } from './coorganisation.service';

/**
 * Co-organisation (D39) under `/api/associations/...`, the prefix nginx already routes here. The
 * one route below is a GET on `:id/events/:eventId/co-organisers`, a shape `AssociationsController`
 * has none of (its event routes are PATCH/DELETE on the event, and `/image`). Proposing, withdrawing
 * and ending ride the event write itself (`coOwnerIds`); accepting and refusing are the generic
 * proposal routes.
 */
@Controller('associations')
@UseGuards(NginxAuthGuard)
export class CoorganisationController {
  constructor(private readonly coorganisation: CoorganisationService) {}

  /** Each co-organiser of the event with its state (accepted, pending, refused), for its editors. */
  @Get(':id/events/:eventId/co-organisers')
  listStates(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Param('id', ParseUUIDPipe) associationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string
  ) {
    return this.coorganisation.listStatesFor(
      associationId,
      eventId,
      xUserId,
      xGlobalAdmin === 'true'
    );
  }

  /**
   * Which side the caller writes the event from, `organiser` or `partner` (owner decision E2): what
   * the event form reads to hide the date and the partner list from a partner.
   */
  @Get(':id/events/:eventId/write-side')
  writeSide(
    @Headers('x-user-id') xUserId: string,
    @Headers('x-global-admin') xGlobalAdmin: string | undefined,
    @Param('id', ParseUUIDPipe) associationId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string
  ) {
    return this.coorganisation.writeSideFor(
      associationId,
      eventId,
      xUserId,
      xGlobalAdmin === 'true'
    );
  }
}
