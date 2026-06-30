import {
  Controller,
  Get,
  Param,
  Headers,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import * as crypto from 'crypto';
import { User } from '../users/entities/user.entity';
import {
  getSocialServiceBase,
  internalSocialRequestConfig,
  internalUserAssociationsPath,
} from '../payment/social-internal-client';

/** Associations projection returned by social-service for a user. */
interface SocialAssociations {
  current: {
    name: string;
    slug: string;
    role: string;
    logoUrl: string | null;
  }[];
  former: {
    name: string;
    role: string;
    logoUrl: string | null;
    startYear: number | null;
    endYear: number | null;
  }[];
}

/**
 * Public, API-key-protected profile endpoint for trusted external apps (e.g. the
 * Sky parrainage tree). Keyed by OIDC `sub`. Aggregates the core user record
 * (identity + bio) with the user's associations fetched from social-service.
 * Exposed through Nginx at /api/external/* WITHOUT the session auth_request:
 * authentication is the x-api-key header matched against EXTERNAL_API_KEY.
 */
@Controller('external')
export class ExternalController {
  private readonly logger = new Logger(ExternalController.name);
  private readonly apiKey = process.env.EXTERNAL_API_KEY ?? '';

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  /** Throws ForbiddenException unless the header matches EXTERNAL_API_KEY (timing-safe). */
  private assertApiKey(key: string): void {
    const expected = Buffer.from(this.apiKey);
    const received = Buffer.from(key ?? '');
    if (
      expected.length === 0 ||
      received.length !== expected.length ||
      !crypto.timingSafeEqual(expected, received)
    ) {
      throw new ForbiddenException();
    }
  }

  /** Aggregated public profile (identity, bio, associations) for an OIDC subject. */
  @Get('profile/:sub')
  async profile(
    @Param('sub') sub: string,
    @Headers('x-api-key') apiKey: string,
  ) {
    this.assertApiKey(apiKey);

    const user = await this.userRepo.findOne({ where: { id: sub } });
    if (!user) {
      throw new NotFoundException();
    }

    // Associations are best-effort: a social-service hiccup must not break the
    // profile (identity + bio still returned).
    let associations: SocialAssociations = { current: [], former: [] };
    try {
      const res = await axios.get<SocialAssociations>(
        getSocialServiceBase() + internalUserAssociationsPath(sub),
        internalSocialRequestConfig(),
      );
      associations = res.data;
    } catch (e) {
      this.logger.warn(
        `Failed to fetch associations for ${sub}: ${(e as Error).message}`,
      );
    }

    return {
      sub: user.id,
      displayName: user.displayName ?? null,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      promo: user.promo ?? null,
      formation: user.formation ?? null,
      bio: user.bio ?? null,
      associations: associations.current,
      formerAssociations: associations.former,
    };
  }
}
