import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleInit,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository, SelectQueryBuilder } from 'typeorm';
import { randomBytes } from 'node:crypto';
import axios from 'axios';
import { User } from './entities/user.entity';
import {
  CreateUserDto,
  UpdateUserDto,
  PublicUserDto,
  DirectoryQueryDto,
  DirectoryUserRow,
} from './dto/user.dto';
import { applyFuzzyNameSearch } from './userSearch';
import { UserBlocksService } from './user-blocks.service';
import { EMPTY_PROFILE, legacyColumns, type MiconnectProfile } from './miconnect-profile';
import { socialUrl } from '../internal/service-urls';
import { RefusalCode, refusalBody } from '../common/refusal-codes';
import { assertMintableUserId } from './user-id';
import { UserIdTakenError, UserRowGoneError, updateUserColumns } from './user-write';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

/** Service managing user persistence and OIDC upsert logic. */
@Injectable()
export class UsersService implements OnModuleInit {
  private readonly logger = new Logger(UsersService.name);

  private readonly internalSecret = process.env.INTERNAL_SECRET ?? '';
  /**
   * Verification service account used by Google/Apple app reviewers. It is hidden from
   * non-admin users (search + directory) and can itself only discover global admins.
   * Configurable via the SERVICE_ACCOUNT_USER_ID env var (GitHub-secret backed); empty
   * disables all service-account restrictions.
   */
  private readonly serviceAccountId = process.env.SERVICE_ACCOUNT_USER_ID?.trim() ?? '';

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly blocksService: UserBlocksService
  ) {}

  /**
   * Enables the PostgreSQL extensions used by user search: `unaccent` (accent-insensitive
   * matching) and `pg_trgm` (trigram similarity, for typo-tolerant fuzzy matching and ranking).
   */
  async onModuleInit(): Promise<void> {
    await this.dataSource.query('CREATE EXTENSION IF NOT EXISTS unaccent');
    await this.dataSource.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    this.logger.log('unaccent + pg_trgm extensions ready');
  }

  /**
   * Creates a NEW user and returns it; an id that already has a row is refused with
   * {@link UserIdTakenError} (409) and the row is left as it is.
   *
   * An `INSERT ... ON CONFLICT DO NOTHING`, never a save: a save of an entity whose id exists
   * overwrites that row with the payload's columns.
   */
  async create(createUserDto: CreateUserDto): Promise<User> {
    // The administrator's mint point: the same rule as the sign-in callback (`user-id.ts`).
    assertMintableUserId(createUserDto.id, this.logger, 'admin-create');
    const result = await this.userRepository
      .createQueryBuilder()
      .insert()
      .into(User)
      .values(this.userRepository.create(createUserDto))
      .orIgnore()
      .returning(['id'])
      .execute();
    if ((result.raw as unknown[]).length !== 1) {
      this.logger.warn(
        `[users.create] refused: user=${createUserDto.id.slice(0, 8)} already exists`
      );
      throw new UserIdTakenError(createUserDto.id);
    }
    this.logger.log(`[users.create] user=${createUserDto.id.slice(0, 8)} created`);
    return this.findOne(createUserDto.id);
  }

  /** Finds a user by ID, throwing NotFoundException if not found. */
  async findOne(id: string): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException(`User #${id} not found`);
    }
    return user;
  }

  /**
   * The public profiles of `ids`, in ONE query, in no guaranteed order.
   *
   * AN ID THAT MATCHES NOTHING IS SIMPLY ABSENT FROM THE ANSWER, and that is the whole contract:
   * `findOne` throws 404 for one missing user, which is the right shape when the caller asked about
   * exactly one and can act on the refusal. A batch cannot borrow it - one deleted account would
   * refuse the nineteen live ones beside it - so the caller reads absence per id and classifies it
   * itself, exactly as it classifies a 404 today.
   *
   * The cap is the caller's problem to respect and this method's to state: the controller refuses a
   * longer list rather than letting an unbounded `IN (...)` reach Postgres.
   */
  async findManyPublic(ids: string[]): Promise<PublicUserDto[]> {
    if (ids.length === 0) return [];
    const users = await this.userRepository.find({ where: { id: In(ids) } });
    return users.map((user) => this.toPublicDto(user));
  }

  /**
   * Writes the provided fields to the user, then answers the row as it now stands.
   *
   * The fields go out as ONE column update of the row (`updateUserColumns`), never a save of a copy
   * read first: a user write updates the columns it names and never saves the row it read.
   */
  async update(id: string, updateUserDto: UpdateUserDto): Promise<User> {
    // The columns this route owns, named one by one: a field added to the DTO reaches the row only
    // once it is written here.
    if (updateUserDto.bio !== undefined) {
      await updateUserColumns(
        this.userRepository,
        id,
        { bio: updateUserDto.bio },
        'users.update',
        this.logger
      );
    } else {
      this.logger.debug(`[users.update] user=${id.slice(0, 8)} nothing to write`);
    }
    return this.findOne(id);
  }

  /**
   * Returns the caller's personal notepad as stored: the ciphertext, plus the
   * legacy plaintext when the note predates encryption and has not been
   * re-saved yet. Only one of the two is ever meaningful - the client re-saves
   * a legacy note immediately, which clears it.
   */
  async getNotes(id: string): Promise<{ ciphertext: string; legacyNotes: string }> {
    const user = await this.findOne(id);
    return {
      ciphertext: user.notesCiphertext ?? '',
      legacyNotes: user.notesCiphertext ? '' : (user.notes ?? ''),
    };
  }

  /**
   * Persists the caller's notepad ciphertext, and drops the legacy plaintext:
   * once an encrypted copy exists, keeping the readable one would defeat the
   * whole change.
   */
  async setNotes(id: string, ciphertext: string): Promise<void> {
    await updateUserColumns(
      this.userRepository,
      id,
      { notesCiphertext: ciphertext, notes: null },
      'notes.set',
      this.logger
    );
  }

  /**
   * Returns the caller's notepad key, generating it on first use. 32 random bytes
   * hex, mirroring an association's vault key. It is served only to its owner, so
   * a database dump alone cannot read the notepad.
   *
   * TWO FIRST CALLS AGREE ON ONE KEY. The key is written by ONE conditional statement that keeps a
   * key already there (`COALESCE`) and answers the key the row holds once it ran; PostgreSQL makes
   * the second of two concurrent statements wait for the first and re-read the row, so both answer
   * the first one's key. A note encrypted under a key a later write replaced would be unreadable.
   */
  async getOrCreateNotesKey(id: string): Promise<string> {
    const user = await this.findOne(id);
    if (user.notesKey) return user.notesKey;

    const minted = randomBytes(32).toString('hex');
    // `UPDATE ... RETURNING` through TypeORM's postgres driver answers `[rows, affectedCount]`.
    const [rows] = (await this.userRepository.query(
      `UPDATE users SET "notesKey" = COALESCE("notesKey", $2) WHERE id = $1 RETURNING "notesKey"`,
      [id, minted]
    )) as [Array<{ notesKey: string }>, number];
    const stored = rows[0]?.notesKey;
    if (!stored) {
      this.logger.warn(
        `[NOTES] user row gone since its read user=${id.slice(0, 8)} - no key minted`
      );
      throw new UserRowGoneError(id);
    }
    if (stored === minted) {
      this.logger.log(`[NOTES] generated a notepad key for ${id.slice(0, 8)}`);
    } else {
      this.logger.log(
        `[NOTES] another call minted the notepad key of ${id.slice(0, 8)} first - answering that one`
      );
    }
    return stored;
  }

  /** Maps a User entity to a PublicUserDto, stripping internal fields. */
  toPublicDto(user: User): PublicUserDto {
    return {
      id: user.id,
      displayName: user.displayName,
      firstName: user.firstName,
      lastName: user.lastName,
      promo: user.promo,
      formation: user.formation,
      campus: user.campus ?? null,
      cursus: user.cursus ?? [],
      posts: user.posts ?? [],
      bio: user.bio,
      createdAt: user.createdAt,
    };
  }

  /**
   * Upsert a user from OIDC provider data (Authentik).
   *
   * EVERY CLAIM THE PROVIDER SENDS IS REFRESHED, AND `firstName`/`lastName` WERE NOT.
   * They were written once, at creation, and never again - so a member who corrected their name in
   * the school directory kept the old one here for ever, while `displayName` beside them tracked
   * the change on the next sign-in. That was invisible only because Authentik's `name` claim is
   * exactly `firstName lastName` for all 436 production accounts (measured 2026-09-22), which is
   * also why nothing could be inferred from the two agreeing. Now that the pair is what every
   * surface PREFERS (`libs/contracts/user-display-name.cases.json`), a column that never updates is
   * a name that never updates.
   *
   * AN EXISTING ACCOUNT IS UPDATED BY COLUMN, NEVER SAVED: the claims that changed go out as ONE
   * column update (`updateUserColumns`). A save of the row read here would write back every column
   * another writer changed since this read, and would insert the row again had it been deleted
   * meanwhile - and the only thing that deletes a user row is the account's erasure. So a row gone
   * since the read throws {@link UserRowGoneError}, which the callback answers with the erasure's
   * refusal; the insert below is reached only when the read found no row at all, and the callback's
   * `confirmAfterSignIn` covers an erasure that commits after it.
   */
  async findOrCreateFromOidc(
    id: string,
    displayName: string | null,
    firstName: string | null,
    lastName: string | null,
    profile: MiconnectProfile = EMPTY_PROFILE
  ): Promise<User> {
    // The MiConnect profile is REPLACED wholesale, unlike the names above: it is the one thing
    // authentik owns outright, so a claim that vanished there must clear here (WP3). `promo` and
    // `formation` are the first cursus entry until every consumer reads `cursus` (WP6).
    const { promo, formation } = legacyColumns(profile.cursus);
    const sameProfile = (u: User) =>
      u.miconnectUuid === profile.miconnectUuid &&
      u.campus === profile.campus &&
      JSON.stringify(u.cursus ?? []) === JSON.stringify(profile.cursus) &&
      JSON.stringify(u.posts ?? []) === JSON.stringify(profile.posts) &&
      (u.promo ?? null) === promo &&
      (u.formation ?? null) === formation;
    const user = await this.userRepository.findOne({ where: { id } });
    if (user) {
      const changes: QueryDeepPartialEntity<User> = {};
      if (displayName && user.displayName !== displayName) changes.displayName = displayName;
      // A claim the provider did not send may not ERASE what is stored: `firstName` is an optional
      // custom claim on this provider, and an Authentik mapping that stops emitting it must leave
      // the name alone rather than blank it. Same shape as `displayName` above, and as `promo`.
      if (firstName && user.firstName !== firstName) changes.firstName = firstName;
      if (lastName && user.lastName !== lastName) changes.lastName = lastName;
      if (!sameProfile(user)) {
        this.logger.debug(`OIDC profile changed for ${id}: campus=${profile.campus}`);
        Object.assign(changes, profile, { promo, formation });
      }
      if (Object.keys(changes).length > 0) {
        try {
          await updateUserColumns(this.userRepository, id, changes, 'oidc.upsert', this.logger);
        } catch (err) {
          // The row is gone since the read: the caller refuses the sign-in, nothing is re-created.
          if (err instanceof UserRowGoneError) throw err;
          // Any other database refusal costs the refresh of the claims, never the sign-in.
          this.logger.warn(`OIDC upsert of ${id} not saved: ${String(err)}`);
        }
        Object.assign(user, changes);
      }
      return user;
    }
    const newUser = this.userRepository.create({
      id,
      displayName: displayName || null,
      firstName: firstName || null,
      lastName: lastName || null,
      ...profile,
      promo,
      formation,
    });
    return await this.userRepository.save(newUser);
  }

  /**
   * Sets or clears the admin flag on a user: ONE `UPDATE` of that column and nothing else, so no
   * other write can carry a stale copy of it back, and a row that is gone answers 404.
   */
  async setAdmin(targetId: string, admin: boolean): Promise<void> {
    this.logger.log(`[ADMIN] user=${targetId.slice(0, 8)} admin=${admin}`);
    await updateUserColumns(this.userRepository, targetId, { admin }, 'admin.set', this.logger);
  }

  /** Returns all users (id, displayName, admin) - admin-only listing. */
  async listAll(): Promise<Pick<User, 'id' | 'displayName' | 'admin'>[]> {
    return this.userRepository
      .createQueryBuilder('user')
      .select(['user.id', 'user.displayName', 'user.admin'])
      .orderBy('user.displayName', 'ASC')
      .getMany();
  }

  /**
   * Whether the given user has global admin privileges, read from the row NOW (one column). The
   * sign-in reads it this way after opening its session, so the token it mints never carries a flag
   * read before a concurrent change.
   */
  async isUserAdmin(userId: string): Promise<boolean> {
    if (!userId) return false;
    const row = await this.userRepository
      .createQueryBuilder('user')
      .select('user.admin', 'admin')
      .where('user.id = :id', { id: userId })
      .getRawOne<{ admin: boolean }>();
    return row?.admin === true;
  }

  /**
   * Restricts a user query builder (alias `user`) to enforce service-account visibility:
   * - The service account itself may only discover global admins.
   * - Non-admin requesters never see the service account.
   * - Global admins are unaffected. No-op when no service account is configured.
   */
  private async applyServiceAccountVisibility(
    qb: SelectQueryBuilder<User>,
    requesterId?: string
  ): Promise<void> {
    const sa = this.serviceAccountId;
    if (!sa) return;
    if (requesterId && requesterId === sa) {
      // The verification account must not be able to browse the wider student body.
      qb.andWhere('user.admin = :saAdminOnly', { saAdminOnly: true });
      return;
    }
    if (!(await this.isUserAdmin(requesterId ?? ''))) {
      qb.andWhere('user.id != :serviceAccountId', { serviceAccountId: sa });
    }
  }

  /**
   * Hides the people this caller may not be shown from a TARGET PICKER: those they blocked, and
   * those who blocked them.
   *
   * THIS SURFACE ONLY, and deliberately not the directory. `search` is what feeds the New chat
   * modal, the salon invitation field and the mention autocomplete - it exists to pick somebody to
   * act on. The directory is a browsing view with promo and cursus filters, and punching a hole in
   * it would make a block visible in a screen that has nothing to do with it.
   *
   * The exclusion is SYMMETRIC. Hiding only the blocked party would let them keep finding the
   * blocker, and hiding only the blocker would let the blocker re-open a conversation they closed.
   */
  private async applyBlockVisibility(
    qb: SelectQueryBuilder<User>,
    requesterId?: string
  ): Promise<void> {
    if (!requesterId) return;
    const hidden = await this.blocksService.invisibleUserIdsFor(requesterId);
    if (hidden.length === 0) return;
    this.logger.debug(`[search] hiding ${hidden.length} blocked account(s) from ${requesterId}`);
    qb.andWhere('user.id NOT IN (:...blockedIds)', { blockedIds: hidden });
  }

  /**
   * Search users by displayName - case-insensitive, accent-insensitive, word-order-insensitive,
   * and typo-tolerant (trigram fuzzy matching). Results are ordered by closeness to the query.
   * Returns up to 10 results. The caller (requesterId) is included in results - callers that
   * must not target themselves (e.g. starting a DM) enforce that as a separate business rule.
   */
  async search(query: string, requesterId?: string): Promise<Pick<User, 'id' | 'displayName'>[]> {
    // `query` is typed `string`, but Express query parsing can yield an array or
    // object at runtime (e.g. `?q=a&q=b` -> string[], `?q[x]=1` -> object). Re-check
    // the runtime type before any string operation to prevent parameter-tampering
    // type confusion (CWE-843) from flowing into the fuzzy SQL matcher.
    if (typeof query !== 'string') return [];
    if (!query || query.length < 1) return [];
    if (query.length > 200)
      throw new BadRequestException(
        refusalBody(RefusalCode.USER_SEARCH_TOO_LONG, 'Search query too long (max 200 chars)', {
          max: 200,
        })
      );

    const qb = this.userRepository
      .createQueryBuilder('user')
      .select(['user.id', 'user.displayName']);

    // Accent-insensitive, word-order-insensitive, typo-tolerant name matching + relevance ordering.
    const applied = applyFuzzyNameSearch(qb, query);
    if (!applied) return [];

    await this.applyServiceAccountVisibility(qb, requesterId);
    await this.applyBlockVisibility(qb, requesterId);

    return qb.take(10).getMany();
  }

  /**
   * Paginated directory search with optional promo, formation and association filters.
   * Requires at least one filter or a name query of ≥ 2 characters. Includes the caller
   * (requesterId) in results - the directory is a browsing view, not a target picker.
   */
  async directory(
    query: DirectoryQueryDto,
    requesterId?: string
  ): Promise<{ users: DirectoryUserRow[]; total: number }> {
    const limit = Math.min(query.limit ?? 20, 50);
    const offset = query.offset ?? 0;
    const q = query.q?.trim() ?? '';
    const formation = query.formation?.trim() ?? '';

    const hasFilter =
      q.length >= 2 ||
      query.promo != null ||
      formation.length > 0 ||
      !!query.campus ||
      !!query.post ||
      !!query.associationId;
    if (!hasFilter) {
      throw new BadRequestException(
        refusalBody(
          RefusalCode.USER_SEARCH_FILTER_REQUIRED,
          'Provide at least one filter (name >= 2 chars, promo, cursus, campus, post, or association)'
        )
      );
    }

    let memberUserIds: string[] | null = null;
    if (query.associationId) {
      memberUserIds = await this.fetchAssociationMemberUserIds(query.associationId);
      if (memberUserIds.length === 0) {
        return { users: [], total: 0 };
      }
    }

    const qb = this.userRepository
      .createQueryBuilder('user')
      .select([
        'user.id',
        'user.displayName',
        'user.promo',
        'user.formation',
        'user.campus',
        'user.cursus',
        'user.posts',
        'user.bio',
      ]);

    // Accent-insensitive, word-order-insensitive, typo-tolerant name matching + relevance ordering.
    // Only when a name query is present; otherwise the directory keeps its alphabetical order below.
    const hasNameQuery = q.length >= 2;
    if (hasNameQuery) {
      applyFuzzyNameSearch(qb, q);
    }

    if (query.promo != null) {
      qb.andWhere('user.promo = :promo', { promo: query.promo });
    }

    if (formation.length > 0) {
      qb.andWhere('unaccent(LOWER(user.formation)) LIKE unaccent(LOWER(:formation))', {
        formation: `%${formation}%`,
      });
    }

    if (query.campus) {
      qb.andWhere('user.campus = :campus', { campus: query.campus });
    }

    if (query.post) {
      qb.andWhere(':post = ANY(user.posts)', { post: query.post });
    }

    if (memberUserIds) {
      qb.andWhere('user.id IN (:...memberUserIds)', { memberUserIds });
    }

    await this.applyServiceAccountVisibility(qb, requesterId);

    // With a name query, applyFuzzyNameSearch already ordered by relevance; otherwise sort by name.
    if (!hasNameQuery) {
      qb.orderBy('user.displayName', 'ASC', 'NULLS LAST');
    }

    const total = await qb.getCount();
    const rows = await qb.skip(offset).take(limit).getMany();

    return {
      users: rows.map((u) => ({
        id: u.id,
        displayName: u.displayName ?? null,
        promo: u.promo ?? null,
        formation: u.formation ?? null,
        campus: u.campus ?? null,
        cursus: u.cursus ?? [],
        posts: u.posts ?? [],
        bio: u.bio ?? null,
      })),
      total,
    };
  }

  /**
   * Asks social-service to grant any cotisation a legacy estate recorded for this user, now that
   * they have signed in and their identity is known.
   *
   * Called on EVERY sign-in rather than on account creation. The claim terminates on durable state
   * in social-service (the staging row is stamped once claimed), so a second call grants nothing;
   * keyed on account creation instead, it would strand every user who signed in before their
   * association's list was loaded and would make one failed grant permanent.
   *
   * Never throws. A cotisation that cannot be granted must not cost somebody their sign-in, and the
   * next sign-in retries it - which is why the failure is logged loudly rather than handled.
   */
  async claimLegacyCotisations(user: User): Promise<void> {
    try {
      await axios.post(
        socialUrl('internal/legacy-cotisations/claim'),
        {
          userId: user.id,
          firstName: user.firstName ?? null,
          lastName: user.lastName ?? null,
          promo: user.promo ?? null,
        },
        { headers: { 'X-Internal-Secret': this.internalSecret }, timeout: 5_000 }
      );
    } catch (err) {
      this.logger.error(
        `[legacy] cotisation claim failed for ${user.id.slice(0, 8)}: ${String(err)} - ` +
          `retried on next sign-in`
      );
    }
  }

  /** Fetches member user IDs from social-service for association-scoped directory search. */
  private async fetchAssociationMemberUserIds(associationId: string): Promise<string[]> {
    try {
      const resp = await axios.get<{ userIds: string[] }>(
        socialUrl(`internal/associations/${encodeURIComponent(associationId)}/member-user-ids`),
        {
          headers: { 'X-Internal-Secret': this.internalSecret },
          timeout: 10_000,
        }
      );
      return resp.data?.userIds ?? [];
    } catch (err) {
      this.logger.warn(
        `[directory] failed to fetch association members asso=${associationId}: ${String(err)}`
      );
      return [];
    }
  }
}
