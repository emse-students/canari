import {
  Injectable,
  NotFoundException,
  OnModuleInit,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import axios from 'axios';
import { User } from './entities/user.entity';
import { CreateUserDto, UpdateUserDto, PublicUserDto } from './dto/user.dto';

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
    console.log('[UsersService] unaccent extension ready');
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

    const terms = query.trim().split(/\s+/).filter(Boolean);
    console.log(`[UsersService] search terms: ${JSON.stringify(terms)}`);

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
