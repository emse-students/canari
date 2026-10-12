import {
  Controller,
  Get,
  Body,
  Patch,
  Put,
  Param,
  Headers,
  UseGuards,
  Query,
  Post,
  Delete,
  HttpCode,
  Res,
  Req,
  ForbiddenException,
  BadRequestException,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { UsersService } from './users.service';
import { UserBlocksService } from './user-blocks.service';
import { AvatarService } from './avatar.service';
import { ProfileEditService } from './profile-edit.service';
import { ProfileCorrectionService } from './profile-correction.service';
import {
  CreateUserDto,
  UpdateUserDto,
  UpdateNotesDto,
  DirectoryQueryDto,
  BlockUserDto,
} from './dto/user.dto';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { GlobalAdminGuard } from '../common/guards/global-admin.guard';

/**
 * The most ids one `GET /users/batch` may carry.
 *
 * It bounds the `IN (...)` that reaches Postgres, and it is a REFUSAL rather than a silent truncation
 * - a caller that sends more gets told, instead of receiving an answer that quietly omits the rest
 * and looks exactly like a page of deleted accounts. The client chunks to this same number, which is
 * why it is stated here, where the refusal is.
 *
 * 100 covers every shape that exists, measured on production 2026-09-15: 421 accounts in all, the
 * largest association roster 27, the largest DM group 2, and a conversation list ~20. The cap is
 * therefore never reached today - it is here so that the day a screen asks for more, it asks in
 * chunks rather than handing Postgres a list nobody bounded.
 */
const MAX_PROFILE_BATCH = 100;

/** Controller handling user profile CRUD, search, and avatar proxy. */
/**
 * Whether an `If-None-Match` header names `etag`. WEAK comparison (RFC 9110 8.8.3.2), because an
 * intermediary may turn a strong validator into a weak one on the way back; `*` matches anything
 * we hold. The upstream token is an opaque asset id, so only equality of the opaque part is asked.
 */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const opaque = (t: string) => t.trim().replace(/^W\//, '');
  const ours = opaque(etag);
  return header.split(',').some((t) => t.trim() === '*' || opaque(t) === ours);
}

@Controller('users')
export class UsersController {
  private readonly logger = new Logger(UsersController.name);

  /**
   * The single `[AVATAR]` line of an avatar request: outcome, status, duration and the target id
   * TRUNCATED to 8 characters (never the full id or the image). `served`/`absent` log at info,
   * every failure at warn, so `grep AVATAR | grep -v outcome=served` finds a failed fetch.
   */
  private logAvatar(
    outcome: 'served' | 'not-modified' | 'absent' | 'unavailable' | 'disabled' | 'rejected',
    status: number,
    startedAt: number,
    userId: string
  ): void {
    const line =
      `[AVATAR] outcome=${outcome} status=${status} ms=${Date.now() - startedAt} ` +
      `target=${String(userId).slice(0, 8)}`;
    if (outcome === 'served' || outcome === 'not-modified' || outcome === 'absent') {
      this.logger.log(line);
    } else this.logger.warn(line);
  }

  constructor(
    private readonly usersService: UsersService,
    private readonly avatarService: AvatarService,
    private readonly blocksService: UserBlocksService,
    private readonly profileEdit: ProfileEditService,
    private readonly corrections: ProfileCorrectionService
  ) {}

  // -- Blocking -------------------------------------------------------------
  //
  // Declared before every `:id` route on purpose: Nest matches in declaration order, and
  // `me/blocks` would otherwise be swallowed by `:id/...` with `id = "me"`.

  /** The people the caller has blocked, with the names needed to unblock them. */
  @UseGuards(NginxAuthGuard)
  @Get('me/blocks')
  listBlocks(@Headers('x-user-id') userId: string) {
    return this.blocksService.listBlocks(userId);
  }

  /**
   * Blocks a person. Idempotent.
   *
   * The blocked person is never told, and no administrator is: a block is a matter between two
   * people (user decision, 2026-08-27). Somebody who wants a moderator involved files a report.
   */
  @UseGuards(NginxAuthGuard)
  @Post('me/blocks')
  blockUser(@Headers('x-user-id') userId: string, @Body() dto: BlockUserDto) {
    return this.blocksService.block(userId, dto.userId);
  }

  /**
   * The caller's own correction request: the open one, else the latest answered one, else `null`.
   * It is what the profile's "request a correction" button shows.
   */
  @UseGuards(NginxAuthGuard)
  @Get('me/profile-correction')
  async myProfileCorrection(@Headers('x-user-id') userId: string) {
    return { request: await this.corrections.latestFor(userId) };
  }

  /**
   * Asks the admins to correct the caller's profile (D10). Only an admin edits a profile, so this is
   * the one way a person gets a wrong campus, formation or name changed. One open request at a time.
   */
  @UseGuards(NginxAuthGuard)
  @Post('me/profile-correction')
  async requestProfileCorrection(
    @Headers('x-user-id') userId: string,
    @Body() body: { message?: unknown }
  ) {
    return { request: await this.corrections.create(userId, body?.message) };
  }

  /**
   * Whether a block stands between the caller and `otherUserId`, in either direction.
   *
   * IT EXISTS SO NOBODY LEARNS THIS BY FAILING. The authoritative refusals sit at the mutations -
   * adding a member to an MLS group, inviting into a private salon - and reaching one of those with
   * a conversation half built is a bad way to find out: the client would already have minted a
   * group and delivered Welcomes before the server said no. The fact is known HERE, cheaply, so the
   * two creation paths ask before they start rather than after.
   *
   * It does not say WHO blocked whom, and that is the whole answer a caller needs.
   */
  @UseGuards(NginxAuthGuard)
  @Get(':otherUserId/block-status')
  async blockStatus(
    @Headers('x-user-id') userId: string,
    @Param('otherUserId') otherUserId: string
  ) {
    return { blocked: await this.blocksService.isBlockedBetween(userId, otherUserId) };
  }

  /** Lifts a block. Only the blocker can, and this is the only surface that offers it. */
  @UseGuards(NginxAuthGuard)
  @Delete('me/blocks/:blockedId')
  unblockUser(@Headers('x-user-id') userId: string, @Param('blockedId') blockedId: string) {
    return this.blocksService.unblock(userId, blockedId);
  }

  /**
   * Search users by id or displayName for autocomplete.
   * Usage: GET /users/search?q=jol
   */
  @UseGuards(NginxAuthGuard)
  @Get('search')
  search(@Query('q') query: string, @Headers('x-user-id') currentUserId: string) {
    return this.usersService.search(query, currentUserId);
  }

  /**
   * Public profiles for a comma-separated list of ids, in ONE request.
   * Usage: `GET /users/batch?ids=<a>,<b>,<c>`
   *
   * WHY IT EXISTS: a chat reload resolved one name per conversation and issued one `GET /users/:id`
   * for each. Measured on production 2026-09-15 from the client's own console: **20 requests for 20
   * distinct ids**, 140-253 ms each (median 235). Nothing here is a new capability - every
   * one of those ids was already readable, one at a time, by the same caller under the same guard.
   *
   * DECLARED BEFORE `:id`, because Nest matches in declaration order and `batch` would otherwise
   * arrive as `id = "batch"` and 404 - which is the failure mode that looks like a missing user
   * rather than a routing mistake.
   *
   * AN UNKNOWN ID IS ABSENT FROM THE ANSWER RATHER THAN AN ERROR: one deleted account may not
   * refuse the nineteen live ones beside it. The client classifies the absence itself, exactly as it
   * classifies the 404 from `:id`.
   */
  @UseGuards(NginxAuthGuard)
  @Get('batch')
  async findMany(@Query('ids') ids: string) {
    // `ids` is TYPED string and Express can still hand over an array (`?ids=a&ids=b`) or an object
    // (`?ids[x]=1`) - the same runtime type confusion `search` re-checks for, and for the same
    // reason: the value flows into a SQL `IN (...)`.
    if (typeof ids !== 'string')
      throw new BadRequestException('ids must be a comma-separated list');
    const requested = [
      ...new Set(
        ids
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      ),
    ];
    if (requested.length > MAX_PROFILE_BATCH) {
      throw new BadRequestException(
        `too many ids (${requested.length} > ${MAX_PROFILE_BATCH}) - split the request`
      );
    }
    return { users: await this.usersService.findManyPublic(requested) };
  }

  /**
   * Paginated user directory with filters (promo, formation, association membership).
   * Usage: GET /users/directory?q=jean&promo=2024&formation=ICM
   */
  @UseGuards(NginxAuthGuard)
  @Get('directory')
  directory(@Query() query: DirectoryQueryDto, @Headers('x-user-id') userId: string) {
    return this.usersService.directory(query, userId);
  }

  /**
   * Get user avatar from external service.
   * Usage: GET /users/{id}/avatar
   *
   * THREE OUTCOMES, THREE ANSWERS, AND THE CACHING IS THE POINT OF THE DISTINCTION:
   *
   * - the image, `no-cache` + the upstream ETag: the browser and the edge MAY store it but must ask
   *   before each reuse, and a matching `If-None-Match` is answered 304. A changed photo therefore
   *   shows on the next render instead of up to 24 h later (the shape is in
   *   `docs/wiki/services/core-service.md`, "One lifetime");
   * - `absent` - the upstream says this user has no photo - is a real ANSWER and is cached briefly,
   *   which is what stops a browser re-asking for the same missing face on every single render;
   * - `unavailable` is not an answer about the avatar, so it is a **502 marked `no-store`**: the
   *   next request tries again, and nothing downstream remembers a passing outage. Answering 404
   *   here would be a lie that gets cached, which is the defect this endpoint was fixed of.
   *
   * EVERY RESPONSE IS BODYLESS EXCEPT THE IMAGE. A JSON error body on a request an `<img>` made is
   * what produced THREE console lines for one benign miss - 404, then `ERR_BLOCKED_BY_ORB` (Chrome
   * refusing to hand a JSON body to an image destination), then `ERR_ABORTED` - all naming the same
   * URL, and all in the window a test run has to read.
   */
  @Get(':id/avatar')
  async getAvatar(@Param('id') userId: string, @Req() req: Request, @Res() res: Response) {
    // ONE `[AVATAR]` LINE PER REQUEST, whatever the outcome - see `logAvatar`.
    const startedAt = Date.now();
    let outcome: Awaited<ReturnType<AvatarService['fetchUserAvatar']>>;
    try {
      outcome = await this.avatarService.fetchUserAvatar(userId);
    } catch (e) {
      this.logAvatar(
        'rejected',
        e instanceof HttpException ? e.getStatus() : 500,
        startedAt,
        userId
      );
      throw e;
    }

    if (outcome.kind === 'absent') {
      this.logAvatar('absent', 404, startedAt, userId);
      res.set({ 'Cache-Control': 'public, max-age=600' });
      res.status(404).end();
      return;
    }
    if (outcome.kind === 'unavailable') {
      this.logAvatar('unavailable', 502, startedAt, userId);
      res.set({ 'Cache-Control': 'no-store' });
      res.status(502).end();
      return;
    }
    // NO PROVIDER ON THIS ESTATE, which is a fact about the deployment and not about the user - so
    // it answers like an absence and is CACHED. Marked `no-store` as an `unavailable` it produced
    // 560 uncached 502s in two hours on dev, one per face per render, and no request could ever
    // have succeeded: the key is read once at startup. Ten minutes matches `absent`, so a key
    // actually being added recovers within one TTL rather than a day.
    if (outcome.kind === 'disabled') {
      this.logAvatar('disabled', 404, startedAt, userId);
      res.set({ 'Cache-Control': 'public, max-age=600' });
      res.status(404).end();
      return;
    }

    // `no-cache` is "store it, revalidate before every reuse" - NOT `max-age=86400`, which republished
    // an upstream `no-cache` as fresh for a day and made a changed photo invisible that long. `public`
    // stays so the edge may keep the bytes; the validator is what makes asking cheap.
    res.set({
      'Content-Type': outcome.contentType,
      'Cache-Control': 'public, no-cache',
    });
    // THE ORIGIN'S VALIDATOR RATHER THAN A PROXY'S INVENTION - AND THAT IS ALL IT IS.
    //
    // `res.send` generates a weak ETag only when none is set, and 304s only against the one that IS
    // (`express/lib/response.js` 169 and 199 on 5.2.1, read rather than assumed). The generated one
    // was computed over the bytes going out, so it discriminates a changed photo EXACTLY as well as
    // this one does: same bytes, same token, either way. Nothing downstream behaves differently.
    //
    // It is set anyway because a proxy that synthesises a validator for content it did not author
    // is making a claim it cannot support - MiGallery's token is keyed on the asset id, and it is
    // the only one that stays meaningful if these bytes are ever re-encoded on the way. Do not file
    // it as the fix for staleness: what shortens that is `max-age`, and the decision about its
    // shape is in `docs/wiki/backlog.md`. The revalidation that actually saves work is the one
    // AvatarService makes upstream.
    if (outcome.etag) {
      res.set({ ETag: outcome.etag });
      // The 304 is decided HERE rather than left to Express, so it is explicit and measurable.
      if (etagMatches(req.headers['if-none-match'], outcome.etag)) {
        this.logAvatar('not-modified', 304, startedAt, userId);
        res.status(304).end();
        return;
      }
    }
    this.logAvatar('served', 200, startedAt, userId);
    res.set({ 'Content-Length': outcome.body.length });
    res.send(outcome.body);
  }

  /** Creates a new user from the provided DTO. Restricted to global admins (OIDC flow uses findOrCreateFromOidc internally). */
  @UseGuards(NginxAuthGuard, GlobalAdminGuard)
  @Post()
  create(@Body() createUserDto: CreateUserDto) {
    return this.usersService.create(createUserDto);
  }

  /**
   * Returns the caller's notepad ciphertext, and the legacy plaintext when the
   * note predates encryption. The server never sees the decrypted content.
   */
  @UseGuards(NginxAuthGuard)
  @Get('me/notes')
  async getMyNotes(@Headers('x-user-id') userId: string) {
    return this.usersService.getNotes(userId);
  }

  /**
   * Stores the caller's notepad ciphertext and drops any legacy plaintext.
   *
   * A missing `ciphertext` is refused rather than treated as an empty notepad:
   * during a deploy a still-cached client sends the old `{ notes }` body, and
   * coercing that to `''` would wipe the note it was trying to save.
   */
  @UseGuards(NginxAuthGuard)
  @Put('me/notes')
  async setMyNotes(@Headers('x-user-id') userId: string, @Body() dto: UpdateNotesDto) {
    if (typeof dto.ciphertext !== 'string') {
      throw new BadRequestException('ciphertext is required - reload the app');
    }
    await this.usersService.setNotes(userId, dto.ciphertext);
    return { ok: true };
  }

  /**
   * Returns the caller's notepad encryption key, generated on first use. Served
   * to the owner only - there is no route that returns another user's key.
   */
  @UseGuards(NginxAuthGuard)
  @Get('me/notes-key')
  async getMyNotesKey(@Headers('x-user-id') userId: string) {
    return { key: await this.usersService.getOrCreateNotesKey(userId) };
  }

  /** Returns the public profile of the requested user, resolving "me" to the caller. */
  @UseGuards(NginxAuthGuard)
  @Get(':id')
  async findOne(@Param('id') id: string, @Headers('x-user-id') requesterId: string) {
    if (id === 'me') {
      id = requesterId;
    }
    const user = await this.usersService.findOne(id);
    return this.usersService.toPublicDto(user);
  }

  /**
   * Permanently deletes the authenticated user's account and all associated data
   * across all services (MLS keys, messages, posts, memberships, Stripe customer).
   * Returns 204 No Content on success.
   */
  @UseGuards(NginxAuthGuard)
  @Delete('me')
  @HttpCode(204)
  async deleteMe(@Headers('x-user-id') userId: string): Promise<void> {
    await this.usersService.deleteUser(userId);
  }

  /** Updates the authenticated user's profile and returns the updated public DTO. */
  @UseGuards(NginxAuthGuard)
  @Patch('me')
  async updateMe(@Headers('x-user-id') userId: string, @Body() updateUserDto: UpdateUserDto) {
    const user = await this.usersService.update(userId, updateUserDto);
    return this.usersService.toPublicDto(user);
  }

  /** Returns all users with their admin status; requires global admin. */
  @UseGuards(NginxAuthGuard, GlobalAdminGuard)
  @Get('admin/list')
  listAll() {
    return this.usersService.listAll();
  }

  /**
   * Replaces a person's WHOLE MiConnect profile (campus, cursus, posts, names); global admin only
   * (D10). Written to authentik first, then Canari's row, then the audit trail - see
   * `ProfileEditService`. Production only: on dev it answers 403 `PROFILE_EDIT_DEV_ESTATE`, because
   * both estates share one MiConnect. Every refusal carries a stable `code` in its body.
   */
  @UseGuards(NginxAuthGuard, GlobalAdminGuard)
  @Put(':id/profile')
  async setProfile(
    @Param('id') targetId: string,
    @Headers('x-user-id') actorId: string,
    @Body() body: unknown
  ) {
    // `requestId` names the correction request this edit answers (WP4b): it then closes the request
    // and tells the person. The rest of the body is the profile, as validated by the edit service.
    const requestId =
      body &&
      typeof body === 'object' &&
      typeof (body as { requestId?: unknown }).requestId === 'string'
        ? (body as { requestId: string }).requestId
        : null;
    const { user, changed, changeId } = requestId
      ? await this.corrections.apply(requestId, targetId, actorId, body)
      : await this.profileEdit.applyEdit(targetId, actorId, body);
    return { user: this.usersService.toPublicDto(user), changed, changeId };
  }

  /** The admin queue of profile correction requests, oldest first. Global admin only (D10). */
  @UseGuards(NginxAuthGuard, GlobalAdminGuard)
  @Get('admin/profile-corrections')
  listProfileCorrections() {
    return this.corrections.listPending();
  }

  /**
   * Refuses a correction request, with an optional note, and tells the person. Applying one is
   * `PUT :id/profile` with the request's id in the body, so the two answers are never one gesture.
   */
  @UseGuards(NginxAuthGuard, GlobalAdminGuard)
  @Post('admin/profile-corrections/:requestId/refuse')
  @HttpCode(200)
  async refuseProfileCorrection(
    @Param('requestId') requestId: string,
    @Headers('x-user-id') actorId: string,
    @Body() body: { note?: unknown }
  ) {
    return this.corrections.refuse(requestId, actorId, body?.note);
  }

  /**
   * Sets or clears the global admin flag on a user; requires global admin.
   * An admin cannot revoke their *own* flag - another admin must do it. This guarantees
   * a sole admin can never lock themselves (and the platform) out, so at least one admin
   * always remains.
   */
  @UseGuards(NginxAuthGuard, GlobalAdminGuard)
  @Patch(':id/admin')
  async setAdmin(
    @Param('id') targetId: string,
    @Headers('x-user-id') callerId: string,
    @Body() body: { admin: boolean }
  ) {
    const isSelf = targetId.trim().toLowerCase() === (callerId ?? '').trim().toLowerCase();
    if (body.admin === false && isSelf) {
      throw new ForbiddenException(
        'Un administrateur ne peut pas retirer ses propres droits ; un autre administrateur doit le faire.'
      );
    }
    await this.usersService.setAdmin(targetId, body.admin);
    return { ok: true, userId: targetId, admin: body.admin };
  }
}
