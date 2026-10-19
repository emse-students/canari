import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { LiveEnabledGuard } from './live-enabled.guard';
import { LIVE_SEGMENT_MAX_BYTES, liveLimits } from './live.constants';
import { LivesService } from './lives.service';
import { readBoundedBody } from './read-bounded-body';

/** The caller nginx authenticated, as every account id is compared: trimmed, lower case. */
const callerOf = (userId: string): string => userId.trim().toLowerCase();

/** A segment index or a manifest offset: digits only, so `''`, `-1` and `0x10` are refused. */
function indexOf(value: string, field: string): number {
  if (!/^[0-9]{1,6}$/.test(value)) throw new BadRequestException({ code: `LIVE_${field}_INVALID` });
  return Number(value);
}

/**
 * The live API (WP-L2, WP-L3; contract in docs/wiki/services/lives.md).
 *
 * BEHIND TWO GUARDS, IN THIS ORDER: the feature switch (`LIVE_ENABLED`, off on production, so a
 * stable release reaches nothing here and every route is a 404), then a signed-in account - a live is
 * the network's (L2), never a signed-out visitor's.
 */
@Controller('lives')
@UseGuards(LiveEnabledGuard, NginxAuthGuard)
export class LivesController {
  constructor(private readonly lives: LivesService) {}

  /** The live's numbers, so a client carries no copy of them. Declared before `:id`. */
  @Get('limits')
  limits() {
    return liveLimits();
  }

  /** The open lives the caller may watch, newest first. */
  @Get()
  list(@Headers('x-user-id') userId: string) {
    return this.lives.listOpen(callerOf(userId));
  }

  /** Starts a live: `{ key: <64 hex>, associationId?: <uuid> }`. 409 if the caller has one open. */
  @Post()
  start(
    @Headers('x-user-id') userId: string,
    @Body() body: { key?: unknown; associationId?: unknown }
  ) {
    return this.lives.start(callerOf(userId), body ?? {});
  }

  /**
   * One live and its key: 404 absent, not in its audience (spaces, as a post) or blocked, 410 ended,
   * 403 removed viewer.
   */
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string, @Headers('x-user-id') userId: string) {
    return this.lives.get(callerOf(userId), id);
  }

  /** What a viewer polls; `?from=<index>` lists from that segment on. Refused as the key is. */
  @Get(':id/manifest')
  async manifest(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-user-id') userId: string,
    @Query('from') from?: string
  ) {
    return this.lives.manifest(
      callerOf(userId),
      id,
      from === undefined ? undefined : indexOf(from, 'FROM')
    );
  }

  /**
   * One sealed segment, raw `application/octet-stream`, at most {@link LIVE_SEGMENT_MAX_BYTES}.
   * Broadcaster only; `index` must be the live's `nextIndex` (or a repeat with the same bytes).
   */
  @Put(':id/segments/:index')
  async putSegment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('index') index: string,
    @Headers('x-user-id') userId: string,
    @Req() req: Request
  ) {
    const at = indexOf(index, 'INDEX');
    const data = await readBoundedBody(req, LIVE_SEGMENT_MAX_BYTES);
    return this.lives.ingest(callerOf(userId), id, at, data);
  }

  /** Ends the live, by its broadcaster: idempotent while the row exists, 404 once it is deleted. */
  @Post(':id/end')
  @HttpCode(200)
  end(@Param('id', ParseUUIDPipe) id: string, @Headers('x-user-id') userId: string) {
    return this.lives.end(callerOf(userId), id);
  }

  /** Removes a viewer from the live, by its broadcaster: `{ viewerId }`. Idempotent. */
  @Post(':id/removed-viewers')
  @HttpCode(200)
  removeViewer(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-user-id') userId: string,
    @Body() body: { viewerId?: unknown }
  ) {
    return this.lives.removeViewer(callerOf(userId), id, body?.viewerId);
  }
}
