import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleInit,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import axios from 'axios';
import { User } from './entities/user.entity';
import {
  CreateUserDto,
  UpdateUserDto,
  PublicUserDto,
  DirectoryQueryDto,
  DirectoryUserRow,
} from './dto/user.dto';

/** Service managing user persistence and OIDC upsert logic. */
@Injectable()
export class UsersService implements OnModuleInit {
  private readonly logger = new Logger(UsersService.name);

  private readonly internalSecret = process.env.INTERNAL_SECRET ?? '';
  private readonly chatDeliveryUrl =
    process.env.CHAT_DELIVERY_URL ?? 'http://chat-delivery-service:3010';
  private readonly socialUrl =
    process.env.SOCIAL_URL ?? 'http://social-service:3014';

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly dataSource: DataSource,
  ) {}

  /** Enables the unaccent PostgreSQL extension used by the search query. */
  async onModuleInit(): Promise<void> {
    await this.dataSource.query('CREATE EXTENSION IF NOT EXISTS unaccent');
    this.logger.log('unaccent extension ready');
  }

  /** Persists a new user entity and returns it. */
  async create(createUserDto: CreateUserDto): Promise<User> {
    const user = this.userRepository.create(createUserDto);
    return await this.userRepository.save(user);
  }

  /** Finds a user by ID, throwing NotFoundException if not found. */
  async findOne(id: string): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException(`User #${id} not found`);
    }
    return user;
  }

  /** Merges the provided fields onto the user and persists the result. */
  async update(id: string, updateUserDto: UpdateUserDto): Promise<User> {
    const user = await this.findOne(id);
    this.userRepository.merge(user, updateUserDto);
    return await this.userRepository.save(user);
  }

  /** Returns the caller's private personal notepad content (empty string if unset). */
  async getNotes(id: string): Promise<string> {
    const user = await this.findOne(id);
    return user.notes ?? '';
  }

  /** Persists the caller's private personal notepad content. */
  async setNotes(id: string, notes: string): Promise<void> {
    const user = await this.findOne(id);
    user.notes = notes;
    await this.userRepository.save(user);
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
      bio: user.bio,
      createdAt: user.createdAt,
    };
  }

  /**
   * Upsert a user from OIDC provider data (Authentik).
   * Creates the user if they don't exist, or updates email/displayName/promo if changed.
   */
  async findOrCreateFromOidc(
    id: string,
    displayName: string | null,
    firstName: string | null,
    lastName: string | null,
    promo: number | null = null,
    formation: string | null = null,
  ): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id } });
    if (user) {
      let updated = false;
      if (displayName && user.displayName !== displayName) {
        user.displayName = displayName;
        updated = true;
      }
      if (promo !== null && user.promo !== promo) {
        user.promo = promo;
        updated = true;
      }
      if (formation !== null && user.formation !== formation) {
        user.formation = formation;
        updated = true;
      }
      if (updated) {
        await this.userRepository.save(user).catch(() => {
          // Ignore unique constraint violations (e.g. email already taken)
        });
      }
      return user;
    }
    const newUser = this.userRepository.create({
      id,
      displayName: displayName || null,
      firstName: firstName || null,
      lastName: lastName || null,
      promo,
      formation: formation || null,
    });
    return await this.userRepository.save(newUser);
  }

  /** Sets or clears the admin flag on a user. */
  async setAdmin(targetId: string, admin: boolean): Promise<void> {
    const user = await this.findOne(targetId);
    user.admin = admin;
    await this.userRepository.save(user);
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
   * Search users by displayName - case-insensitive, accent-insensitive, and
   * word-order-insensitive. All whitespace-delimited terms must match.
   * Returns up to 10 results, excluding the current user if specified.
   */
  async search(
    query: string,
    excludeUserId?: string,
  ): Promise<Pick<User, 'id' | 'displayName'>[]> {
    if (!query || query.length < 1) return [];
    if (query.length > 200)
      throw new BadRequestException('Search query too long (max 200 chars)');

    const terms = query.trim().split(/\s+/).filter(Boolean);
    this.logger.debug(`search terms: ${JSON.stringify(terms)}`);

    const qb = this.userRepository
      .createQueryBuilder('user')
      .select(['user.id', 'user.displayName']);

    // Each term must appear somewhere in the name (AND logic across terms)
    terms.forEach((term, i) => {
      qb.andWhere(
        `unaccent(LOWER(user.displayName)) LIKE unaccent(LOWER(:term${i}))`,
        { [`term${i}`]: `%${term}%` },
      );
    });

    if (excludeUserId) {
      qb.andWhere('user.id != :excludeId', { excludeId: excludeUserId });
    }

    return qb.take(10).getMany();
  }

  /**
   * Paginated directory search with optional promo, formation and association filters.
   * Requires at least one filter or a name query of ≥ 2 characters.
   */
  async directory(
    query: DirectoryQueryDto,
    excludeUserId?: string,
  ): Promise<{ users: DirectoryUserRow[]; total: number }> {
    const limit = Math.min(query.limit ?? 20, 50);
    const offset = query.offset ?? 0;
    const q = query.q?.trim() ?? '';
    const formation = query.formation?.trim() ?? '';

    const hasFilter =
      q.length >= 2 ||
      query.promo != null ||
      formation.length > 0 ||
      !!query.associationId;
    if (!hasFilter) {
      throw new BadRequestException(
        'Indiquez au moins un critère (nom ≥ 2 caractères, promo, cursus ou association)',
      );
    }

    let memberUserIds: string[] | null = null;
    if (query.associationId) {
      memberUserIds = await this.fetchAssociationMemberUserIds(
        query.associationId,
      );
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
        'user.bio',
      ]);

    if (q.length >= 2) {
      const terms = q.split(/\s+/).filter(Boolean);
      terms.forEach((term, i) => {
        qb.andWhere(
          `unaccent(LOWER(user.displayName)) LIKE unaccent(LOWER(:term${i}))`,
          { [`term${i}`]: `%${term}%` },
        );
      });
    }

    if (query.promo != null) {
      qb.andWhere('user.promo = :promo', { promo: query.promo });
    }

    if (formation.length > 0) {
      qb.andWhere(
        'unaccent(LOWER(user.formation)) LIKE unaccent(LOWER(:formation))',
        {
          formation: `%${formation}%`,
        },
      );
    }

    if (memberUserIds) {
      qb.andWhere('user.id IN (:...memberUserIds)', { memberUserIds });
    }

    if (excludeUserId) {
      qb.andWhere('user.id != :excludeId', { excludeId: excludeUserId });
    }

    qb.orderBy('user.displayName', 'ASC', 'NULLS LAST');

    const total = await qb.getCount();
    const rows = await qb.skip(offset).take(limit).getMany();

    return {
      users: rows.map((u) => ({
        id: u.id,
        displayName: u.displayName ?? null,
        promo: u.promo ?? null,
        formation: u.formation ?? null,
        bio: u.bio ?? null,
      })),
      total,
    };
  }

  /** Fetches member user IDs from social-service for association-scoped directory search. */
  private async fetchAssociationMemberUserIds(
    associationId: string,
  ): Promise<string[]> {
    try {
      const resp = await axios.get<{ userIds: string[] }>(
        `${this.socialUrl}/internal/associations/${encodeURIComponent(associationId)}/member-user-ids`,
        {
          headers: { 'X-Internal-Secret': this.internalSecret },
          timeout: 10_000,
        },
      );
      return resp.data?.userIds ?? [];
    } catch (err) {
      this.logger.warn(
        `[directory] failed to fetch association members asso=${associationId}: ${String(err)}`,
      );
      return [];
    }
  }

  /**
   * Permanently deletes a user account and all associated data across services.
   * Order: Stripe customer → chat-delivery data → social data → user row.
   * Downstream failures are logged but do not abort the deletion - the user row
   * is always removed so the account is inaccessible even if a service is down.
   */
  async deleteUser(userId: string): Promise<void> {
    this.logger.log(`[deleteUser] starting userId=${userId}`);

    const user = await this.userRepository.findOne({ where: { id: userId } });

    // Best-effort Stripe customer deletion - skip if not configured or no customer
    if (user?.stripeCustomerId) {
      try {
        const { default: Stripe } = await import('stripe');
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', {
          apiVersion: '2026-03-25.dahlia',
        });
        await stripe.customers.del(user.stripeCustomerId);
        this.logger.log(
          `[deleteUser] stripe customer deleted userId=${userId}`,
        );
      } catch (err) {
        this.logger.warn(
          `[deleteUser] stripe deletion failed userId=${userId}: ${String(err)}`,
        );
      }
    }

    const headers = { 'x-internal-secret': this.internalSecret };

    // Best-effort: delete chat-delivery data (MLS keys, devices, messages)
    await axios
      .delete(
        `${this.chatDeliveryUrl}/internal/users/${encodeURIComponent(userId)}`,
        { headers },
      )
      .catch((err) =>
        this.logger.warn(
          `[deleteUser] chat-delivery failed userId=${userId}: ${String(err)}`,
        ),
      );

    // Best-effort: delete/anonymise social data (posts, follows, memberships)
    await axios
      .delete(
        `${this.socialUrl}/internal/users/${encodeURIComponent(userId)}`,
        { headers },
      )
      .catch((err) =>
        this.logger.warn(
          `[deleteUser] social failed userId=${userId}: ${String(err)}`,
        ),
      );

    // Hard-delete the user row last so login becomes impossible immediately after
    await this.userRepository.delete({ id: userId });
    this.logger.log(`[deleteUser] done userId=${userId}`);
  }
}
