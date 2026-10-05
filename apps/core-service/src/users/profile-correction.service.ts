import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import axios from 'axios';
import { QueryFailedError, Repository } from 'typeorm';
import { ProfileCorrectionRequest } from './entities/profile-correction-request.entity';
import { User } from './entities/user.entity';
import { ProfileEditService, type ProfileEditResult } from './profile-edit.service';
import {
  ProfileCorrectionAlreadyPendingError,
  ProfileCorrectionInvalidError,
  ProfileCorrectionNotFoundError,
  ProfileCorrectionNotPendingError,
} from './profile-correction.errors';
import { socialUrl } from '../internal/service-urls';

/** The longest message a person may write to the admins. */
export const CORRECTION_MESSAGE_MAX = 1000;
/** The longest note an admin may attach to a refusal. */
export const CORRECTION_NOTE_MAX = 500;

/** A queue row with the name the admin needs to recognise the person. */
export interface CorrectionQueueRow extends ProfileCorrectionRequest {
  displayName: string | null;
}

/**
 * The correction request of D10: a person asks, an admin applies or refuses, the person is told.
 *
 * WHO MAY DO WHAT is the controller's guards' business (`/users/me/...` for the person,
 * `/users/admin/...` for admins); this service owns the lifecycle - one open request per person,
 * answered exactly once - and the notification that closes it.
 */
@Injectable()
export class ProfileCorrectionService {
  private readonly logger = new Logger(ProfileCorrectionService.name);
  private readonly internalSecret = process.env.INTERNAL_SECRET ?? '';

  constructor(
    @InjectRepository(ProfileCorrectionRequest)
    private readonly requests: Repository<ProfileCorrectionRequest>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly profileEdit: ProfileEditService
  ) {}

  /**
   * Files a request for `userId`. At most one is open per person: the partial unique index is the
   * gate, so two tabs cannot both succeed, and the typed refusal is what the loser reads.
   */
  async create(userId: string, message: unknown): Promise<ProfileCorrectionRequest> {
    const text = typeof message === 'string' ? message.trim() : '';
    if (!text || text.length > CORRECTION_MESSAGE_MAX) {
      this.logger.warn(`[PROFILE_CORRECTION] refused: invalid message from ${userId.slice(0, 8)}`);
      throw new ProfileCorrectionInvalidError(CORRECTION_MESSAGE_MAX);
    }
    try {
      const saved = await this.requests.save(this.requests.create({ userId, message: text }));
      this.logger.log(
        `[PROFILE_CORRECTION] filed ${saved.id.slice(0, 8)} by ${userId.slice(0, 8)}`
      );
      return saved;
    } catch (err) {
      if (isUniqueViolation(err)) {
        this.logger.warn(`[PROFILE_CORRECTION] ${userId.slice(0, 8)} already has an open request`);
        throw new ProfileCorrectionAlreadyPendingError();
      }
      this.logger.error(
        `[PROFILE_CORRECTION] could not file for ${userId.slice(0, 8)}: ${String(err)}`
      );
      throw err;
    }
  }

  /** The caller's open request, or their latest answered one, or null: what the button shows. */
  async latestFor(userId: string): Promise<ProfileCorrectionRequest | null> {
    const open = await this.requests.findOne({ where: { userId, status: 'pending' } });
    if (open) return open;
    return this.requests.findOne({ where: { userId }, order: { createdAt: 'DESC' } });
  }

  /** The admin queue: pending requests first-come-first-served, with each person's name. */
  async listPending(): Promise<CorrectionQueueRow[]> {
    const rows = await this.requests.find({
      where: { status: 'pending' },
      order: { createdAt: 'ASC' },
    });
    if (rows.length === 0) return [];
    const people = await this.users.find({
      where: rows.map((r) => ({ id: r.userId })),
      select: { id: true, displayName: true },
    });
    const names = new Map(people.map((u) => [u.id, u.displayName ?? null]));
    return rows.map((r) => ({ ...r, displayName: names.get(r.userId) ?? null }));
  }

  /**
   * Applies `input` to the requester's profile as the answer to `requestId`. The request is checked
   * pending BEFORE authentik is written; the guarded update inside the edit's transaction is what
   * holds under a race. The person is told afterwards.
   */
  async apply(
    requestId: string,
    targetId: string,
    actorId: string,
    input: unknown
  ): Promise<ProfileEditResult> {
    const request = await this.pendingOrThrow(requestId);
    if (request.userId !== targetId) {
      // An edit of one person may not close another person's request.
      this.logger.warn(
        `[PROFILE_CORRECTION] ${requestId.slice(0, 8)} is not ${targetId.slice(0, 8)}'s`
      );
      throw new ProfileCorrectionNotFoundError();
    }
    const result = await this.profileEdit.applyEdit(request.userId, actorId, input, { requestId });
    await this.notify(request, 'applied');
    return result;
  }

  /** Refuses `requestId` with an optional note, and tells the person. */
  async refuse(
    requestId: string,
    actorId: string,
    note: unknown
  ): Promise<ProfileCorrectionRequest> {
    const request = await this.pendingOrThrow(requestId);
    const text = typeof note === 'string' ? note.trim().slice(0, CORRECTION_NOTE_MAX) : '';
    const answered = await this.requests.update(
      { id: requestId, status: 'pending' },
      {
        status: 'refused',
        resolvedAt: new Date(),
        resolvedBy: actorId,
        resolutionNote: text || null,
      }
    );
    if (answered.affected !== 1) throw new ProfileCorrectionNotPendingError();
    this.logger.log(
      `[PROFILE_CORRECTION] ${requestId.slice(0, 8)} refused by ${actorId.slice(0, 8)}`
    );
    const refused = { ...request, resolutionNote: text || null };
    await this.notify(refused, 'refused');
    return { ...refused, status: 'refused', resolvedBy: actorId, resolvedAt: new Date() };
  }

  private async pendingOrThrow(requestId: string): Promise<ProfileCorrectionRequest> {
    const request = await this.requests.findOne({ where: { id: requestId } });
    if (!request) throw new ProfileCorrectionNotFoundError();
    if (request.status !== 'pending') throw new ProfileCorrectionNotPendingError();
    return request;
  }

  /**
   * Tells the requester through the notifications the app already has (social-service owns them).
   * The answer is already durable, so a failure here is logged at `error` and never rolled back:
   * the person will see the outcome on their profile, but a lost notification is a lost message to
   * a person and must not go unseen.
   */
  private async notify(
    request: ProfileCorrectionRequest,
    outcome: 'applied' | 'refused'
  ): Promise<void> {
    try {
      await axios.post(
        socialUrl('internal/notifications/profile-correction'),
        {
          recipientId: request.userId,
          outcome,
          requestId: request.id,
          note: request.resolutionNote ?? undefined,
        },
        { headers: { 'X-Internal-Secret': this.internalSecret }, timeout: 5_000 }
      );
    } catch (err) {
      this.logger.error(
        `[PROFILE_CORRECTION] ${outcome} notification for ${request.userId.slice(0, 8)} was NOT ` +
          `delivered: ${String(err)}`
      );
    }
  }
}

/** Postgres unique_violation, read from the driver's code rather than from its message. */
function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof QueryFailedError &&
    (err as QueryFailedError & { driverError?: { code?: string } }).driverError?.code === '23505'
  );
}
