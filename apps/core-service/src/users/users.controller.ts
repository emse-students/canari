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
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import type { Response } from 'express';
import { UsersService } from './users.service';
import { UserBlocksService } from './user-blocks.service';
import { AvatarService } from './avatar.service';
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
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly avatarService: AvatarService,
    private readonly blocksService: UserBlocksService
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
   * - the image, cached for a day, as before;
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
  async getAvatar(@Param('id') userId: string, @Res() res: Response) {
    const outcome = await this.avatarService.fetchUserAvatar(userId);

    if (outcome.kind === 'absent') {
      res.set({ 'Cache-Control': 'public, max-age=600' });
      res.status(404).end();
      return;
    }
    if (outcome.kind === 'unavailable') {
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
      res.set({ 'Cache-Control': 'public, max-age=600' });
      res.status(404).end();
      return;
    }

    res.set({
      'Content-Type': outcome.contentType,
      'Content-Length': outcome.body.length,
      'Cache-Control': 'public, max-age=86400',
    });
    // MiGALLERY'S VERSION, NOT EXPRESS'S INVENTION - and setting it is the whole of the change,
    // because `res.send` only generates a weak ETag when none is set and only 304s when the request
    // is `fresh` against the one that IS - `express/lib/response.js` lines 169 and 199 on 5.2.1,
    // read rather than assumed, because the entire change is a bet on those two lines. That generated ETag was computed over whatever bytes went
    // out, so it could confirm nothing until the 24 h above had already elapsed; this one is keyed
    // on the asset id upstream, so it changes exactly when the user changes their photo.
    //
    // THIS DOES NOT SHORTEN THE 24 h, and it is not meant to. It makes the revalidation that
    // eventually happens be about the PHOTO instead of about a clock, and it saves the body on
    // every conditional request that reaches us. Shortening it needs the decision recorded in
    // `docs/wiki/backlog.md` - `no-cache` plus this ETag, or a busted URL - and a smaller number
    // chosen as a compromise would be the same defect at a different rate.
    if (outcome.etag) res.set({ ETag: outcome.etag });
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
