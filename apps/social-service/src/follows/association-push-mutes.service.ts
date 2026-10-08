import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AssociationPushMute } from './entities/association-push-mute.entity';
import { Association } from '../associations/entities/association.entity';

/**
 * Notification types that reach a READER of an association and that a mute therefore silences.
 *
 * A mute is an allowlist by construction: a type absent here is never muted. `repost_proposed`,
 * `coorganise_proposed` and the six `event_*` types go to the association's MANAGERS and carry
 * work they must do (a proposal to approve, an agenda decision), so a reader-side mute must not
 * reach them. `followed_post` is a person's post, not an association's. `mention`, `reply`,
 * `reaction` and `comment` are somebody addressing YOU.
 */
export const MUTABLE_PUSH_TYPES: ReadonlySet<string> = new Set([
  'association_post',
  'association_repost',
]);

/** A muted association as the settings list shows it. */
export type MutedAssociation = Pick<Association, 'id' | 'name' | 'slug' | 'logoUrl'>;

/**
 * Per-association push mutes. Own rows only: every method takes the CALLER's id from the gateway
 * header and never a user id from the body.
 */
@Injectable()
export class AssociationPushMutesService {
  private readonly logger = new Logger(AssociationPushMutesService.name);

  constructor(
    @InjectRepository(AssociationPushMute) private readonly repo: Repository<AssociationPushMute>,
    @InjectRepository(Association) private readonly assoRepo: Repository<Association>
  ) {}

  /** Mutes one association for the caller. Idempotent. 404 for an association that does not exist. */
  async mute(userId: string, associationId: string): Promise<{ ok: boolean }> {
    if (!(await this.assoRepo.exists({ where: { id: associationId } }))) {
      throw new NotFoundException('Association not found');
    }
    await this.repo.upsert({ userId, associationId }, ['userId', 'associationId']);
    this.logger.log(
      `[MUTE] user=${userId.slice(0, 8)} muted association=${associationId.slice(0, 8)}`
    );
    return { ok: true };
  }

  /** Lifts a mute. Idempotent: unmuting what was not muted is not an error. */
  async unmute(userId: string, associationId: string): Promise<{ ok: boolean }> {
    await this.repo.delete({ userId, associationId });
    this.logger.log(
      `[MUTE] user=${userId.slice(0, 8)} unmuted association=${associationId.slice(0, 8)}`
    );
    return { ok: true };
  }

  /** Whether the caller muted this association. */
  async isMuted(userId: string, associationId: string): Promise<boolean> {
    return this.repo.exists({ where: { userId, associationId } });
  }

  /** The associations the caller muted, for the notification settings, by name. */
  async listMuted(userId: string): Promise<MutedAssociation[]> {
    const rows = await this.repo.find({ where: { userId } });
    if (rows.length === 0) return [];
    const assos = await this.assoRepo.findBy({ id: In(rows.map((r) => r.associationId)) });
    return assos
      .map((a) => ({ id: a.id, name: a.name, slug: a.slug, logoUrl: a.logoUrl }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Of `recipientIds`, the ones who muted `associationId` - the server-side half of the mute, asked
   * by the one place that pushes. A client never filters its own pushes.
   */
  async mutedAmong(associationId: string, recipientIds: string[]): Promise<Set<string>> {
    if (recipientIds.length === 0) return new Set();
    const rows = await this.repo.find({
      where: { associationId, userId: In(recipientIds) },
      select: { userId: true },
    });
    return new Set(rows.map((r) => r.userId));
  }
}
