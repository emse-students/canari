import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { CreateUserDto, UpdateUserDto, PublicUserDto } from './dto/user.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async create(createUserDto: CreateUserDto): Promise<User> {
    const user = this.userRepository.create(createUserDto);
    return await this.userRepository.save(user);
  }

  async findOne(id: string): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException(`User #${id} not found`);
    }
    return user;
  }

  async update(id: string, updateUserDto: UpdateUserDto): Promise<User> {
    const user = await this.findOne(id);
    this.userRepository.merge(user, updateUserDto);
    return await this.userRepository.save(user);
  }

  toPublicDto(user: User): PublicUserDto {
    return {
      id: user.id,
      displayName: user.displayName,
      firstName: user.firstName,
      lastName: user.lastName,
      promo: user.promo,
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
    });
    return await this.userRepository.save(newUser);
  }

  /**
   * Search users by displayName (case-insensitive prefix match).
   * Returns up to 10 results, excluding the current user.
   */
  async search(
    query: string,
    excludeUserId?: string,
  ): Promise<Pick<User, 'id' | 'displayName'>[]> {
    if (!query || query.length < 1) return [];

    const qb = this.userRepository
      .createQueryBuilder('user')
      .select(['user.id', 'user.displayName'])
      .where('user.displayName ILIKE :q', {
        q: `%${query}%`,
      });

    if (excludeUserId) {
      qb.andWhere('user.id != :excludeId', { excludeId: excludeUserId });
    }

    return qb.take(10).getMany();
  }
}
