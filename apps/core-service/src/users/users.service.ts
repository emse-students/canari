import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto';

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

  /**
   * Upsert a user from OIDC provider data (Authentik).
   * Creates the user if they don't exist, or updates email/displayName if changed.
   */
  async findOrCreateFromOidc(
    id: string,
    email: string | null,
    displayName: string | null,
  ): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id } });
    if (user) {
      let updated = false;
      if (email && user.email !== email) {
        user.email = email;
        updated = true;
      }
      if (displayName && user.displayName !== displayName) {
        user.displayName = displayName;
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
      email: email || null,
      displayName: displayName || null,
    });
    try {
      return await this.userRepository.save(newUser);
    } catch {
      // If email constraint fails, try without email (dev scenario)
      newUser.email = null;
      return await this.userRepository.save(newUser);
    }
  }

  /**
   * Search users by id or displayName (case-insensitive prefix match).
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
      .where('user.id ILIKE :q OR user.displayName ILIKE :q', {
        q: `${query}%`,
      });

    if (excludeUserId) {
      qb.andWhere('user.id != :excludeId', { excludeId: excludeUserId });
    }

    return qb.take(10).getMany();
  }
}
