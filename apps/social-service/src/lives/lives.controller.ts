import {
  BadRequestException,
  Body,
  ForbiddenException,
  Controller,
  Delete,
  Get,
  Header,
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
import { AssociationsService } from '../associations/associations.service';
import { LiveEnabledGuard } from './live-enabled.guard';
import { LIVE_SEGMENT_MAX_BYTES, liveLimits } from './live.constants';
import { LiveChatService, type LiveChatBlock } from './live-chat.service';
import { LivesService, type LiveManifest } from './lives.service';
import { readBoundedBody } from './read-bounded-body';

/** The caller nginx authenticated, as every account id is compared: trimmed, lower case. */
export const callerOf = (userId: string): string => userId.trim().toLowerCase();

/** A segment index or a manifest offset: digits only, so `''`, `-1` and `0x10` are refused. */
function indexOf(value: string, field: string): number {
  if (!/^[0-9]{1,6}$/.test(value)) throw new BadRequestException({ code: `LIVE_${field}_INVALID` });
  return Number(value);
}

/** A chat cursor (WP-L6): a sequence number, digits only, within a `integer` column. */
function seqOf(value: string, field: string): number {
  if (!/^[0-9]{1,9}$/.test(value)) throw new BadRequestException({ code: `LIVE_${field}_INVALID` });
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
  constructor(
    private readonly lives: LivesService,
    private readonly associations: AssociationsService,
    private readonly chat: LiveChatService
  ) {}

  /** The live's numbers, so a client carries no copy of them. Declared before `:id`. */
  @Get('limits')
  limits() {
    return liveLimits();
  }

  /**
   * The caller's standing with the first-live rules (L11): `{ version, acceptedVersion, acceptedAt }`.
   * The pre-live screen shows the rules when `acceptedVersion` is below `version`, and the start then
   * carries `acceptedRulesVersion`. Declared before `:id`.
   */
  @Get('rules')
  rules(@Headers('x-user-id') userId: string) {
    return this.lives.rulesStatus(callerOf(userId));
  }

  /** The open lives the caller may watch, newest first. */
  @Get()
  list(@Headers('x-user-id') userId: string) {
    return this.lives.listOpen(callerOf(userId));
  }

  /**
   * Starts a live: `{ key: <64 hex>, associationId?: <uuid>, acceptedRulesVersion?: <int> }`. 409 if
   * the caller has one open; 403 `LIVE_RULES_NOT_ACCEPTED` while the first-live rules are not
   * accepted (send `acceptedRulesVersion` when the member tapped Start on them).
   */
  @Post()
  start(
    @Headers('x-user-id') userId: string,
    @Body() body: { key?: unknown; associationId?: unknown; acceptedRulesVersion?: unknown }
  ) {
    return this.lives.start(callerOf(userId), body ?? {});
  }

  /**
   * One live and its key: 404 absent, not in its audience (spaces, as a post) or blocked, 410 ended,
   * 403 removed viewer, 503 `LIVE_FULL` past the host's viewer cap (the read takes a seat).
   * `no-store`: a key never sits in any cache.
   */
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  get(@Param('id', ParseUUIDPipe) id: string, @Headers('x-user-id') userId: string) {
    return this.lives.get(callerOf(userId), id);
  }

  /**
   * What a viewer polls; `?from=<index>` lists from that segment on. Refused as the key is, and each
   * poll renews the viewer's seat. `no-store`: the manifest is the live edge, so the shortest cache
   * is none - a copy one poll old is a viewer one segment behind, and the answer is per viewer
   * (a removed one is refused), so no shared cache may hold it. The SEGMENTS are the cached half.
   */
  @Get(':id/manifest')
  @Header('Cache-Control', 'no-store')
  async manifest(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-user-id') userId: string,
    @Query('from') from?: string,
    @Query('chat') chat?: string,
    @Query('messagesAfter') messagesAfter?: string,
    @Query('reactionsAfter') reactionsAfter?: string
  ): Promise<LiveManifest & { chat?: LiveChatBlock }> {
    const caller = callerOf(userId);
    // The cursors are checked BEFORE the manifest, so a malformed one never costs a seat renewal.
    const cursors =
      chat === '1'
        ? {
            messagesAfter:
              messagesAfter === undefined ? undefined : seqOf(messagesAfter, 'MESSAGES_AFTER'),
            reactionsAfter:
              reactionsAfter === undefined ? undefined : seqOf(reactionsAfter, 'REACTIONS_AFTER'),
          }
        : null;
    const manifest = await this.lives.manifest(
      caller,
      id,
      from === undefined ? undefined : indexOf(from, 'FROM')
    );
    if (!cursors) return manifest;
    // THE CHAT RIDES THE POLL THE VIEWER ALREADY MAKES (WP-L6, C3): one request a tick, read after
    // the manifest let this viewer watch.
    return { ...manifest, chat: await this.chat.read(caller, id, cursors) };
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

  /** The viewer leaves: its seat goes back to the host's cap now rather than when its lease lapses. */
  @Delete(':id/seat')
  @HttpCode(204)
  async leave(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-user-id') userId: string
  ): Promise<void> {
    await this.lives.leave(callerOf(userId), id);
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

  /**
   * STAFF CUT a live (WP-L8): `{ reason: 'spam'|'harassment'|'inappropriate'|'other', details? }`.
   * Who may: `isContentModerator` - a platform admin or a BDE member holding `MODERATE`, the ONE
   * predicate of the posts' moderation controls and of `/api/moderation`. Anyone else is 403
   * `LIVE_CUT_FORBIDDEN`, asked BEFORE the live is looked up, so the refusal says nothing about
   * whether the live exists. Idempotent: a repeat answers the first cut with `newlyCut: false`.
   */
  @Post(':id/cut')
  @HttpCode(200)
  async cut(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') globalAdmin: string | undefined,
    @Body() body: { reason?: unknown; details?: unknown }
  ) {
    const caller = callerOf(userId);
    const mayModerate = await this.associations.isContentModerator(caller, {
      isGlobalAdmin: globalAdmin === 'true',
    });
    if (!mayModerate) throw new ForbiddenException({ code: 'LIVE_CUT_FORBIDDEN' });
    return this.lives.cut(caller, id.toLowerCase(), body ?? {});
  }
}
