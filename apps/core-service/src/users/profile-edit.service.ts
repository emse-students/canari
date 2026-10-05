import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { ProfileChange } from './entities/profile-change.entity';
import { ProfileCorrectionRequest } from './entities/profile-correction-request.entity';
import { ProfileCorrectionNotPendingError } from './profile-correction.errors';
import { MiconnectEditorClient } from './miconnect-editor.client';
import { legacyColumns, validateProfileEdit, type ProfileSnapshot } from './miconnect-profile';
import { ProfileEditInvalidError, ProfileEditNotLinkedError } from './profile-edit.errors';

/** What an applied edit reports back. `changeId` is null when nothing differed and nothing was traced. */
export interface ProfileEditResult {
  user: User;
  changed: boolean;
  changeId: string | null;
}

/**
 * An admin edits a person's MiConnect profile from Canari (D9, D10).
 *
 * THE ORDER IS THE DESIGN: authentik first, because it is the source of truth and every other
 * application reads it at the next sign-in (D14); then Canari's own row, because Canari never
 * re-reads authentik for an active session (a session is 7 days idle, so "the next sign-in" would be
 * never); then the audit row, in the SAME transaction as that row, so a trace exists exactly when
 * both sources were written. A failure at authentik stops everything with nothing changed; a failure
 * after it is logged loud, because the sources now disagree until the person's next sign-in
 * re-reads the profile into Canari's columns.
 */
@Injectable()
export class ProfileEditService {
  private readonly logger = new Logger(ProfileEditService.name);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly editor: MiconnectEditorClient
  ) {}

  /**
   * Applies `input` as `targetId`'s whole profile, on behalf of `actorId`.
   *
   * Throws a typed error from `profile-edit.errors.ts` for every refusal; the estate and token are
   * checked BEFORE the database is touched, so the dev refusal costs nothing and reveals nothing.
   *
   * With `requestId`, the edit answers that correction request (WP4b): the audit row names it, and
   * the request is marked applied in the SAME transaction, so a request is answered exactly when
   * both sources hold the edit. The caller has checked the request is pending; the guarded update
   * here is what makes that true under a race.
   */
  async applyEdit(
    targetId: string,
    actorId: string,
    input: unknown,
    opts: { requestId?: string } = {}
  ): Promise<ProfileEditResult> {
    this.logger.log(`[PROFILE_EDIT] actor=${actorId.slice(0, 8)} target=${targetId.slice(0, 8)}`);
    // The estate first: on dev nothing else is worth reading, and nothing about the request leaks.
    this.editor.assertAvailable();
    const checked = validateProfileEdit(input);
    if (!checked.ok) {
      this.logger.warn(
        `[PROFILE_EDIT] refused: invalid (${checked.problems.map((p) => p.field).join(',')})`
      );
      throw new ProfileEditInvalidError(checked.problems);
    }

    const user = await this.users.findOne({ where: { id: targetId } });
    if (!user) {
      this.logger.warn(`[PROFILE_EDIT] refused: ${targetId.slice(0, 8)} is not a Canari user`);
      throw new NotFoundException(`User #${targetId} not found`);
    }
    if (!user.miconnectUuid) {
      this.logger.warn(`[PROFILE_EDIT] refused: ${targetId.slice(0, 8)} has no miconnect uuid yet`);
      throw new ProfileEditNotLinkedError();
    }

    const record = await this.editor.findUserByUuid(user.miconnectUuid);
    const existing = record.attributes.profile;
    const before = existing && typeof existing === 'object' ? (existing as ProfileSnapshot) : null;
    // Unknown keys of a future profile version survive the edit; the five this form owns win.
    const after: ProfileSnapshot = { ...before, ...checked.profile };

    const unchanged = before !== null && canonical(before) === canonical(after);
    if (!unchanged) {
      await this.editor.writeUser(record.pk, {
        name: `${after.firstName} ${after.lastName}`,
        // The WHOLE bag, read-modify-write: authentik's PATCH replaces `attributes`.
        attributes: { ...record.attributes, profile: after },
      });
      this.logger.log(`[PROFILE_EDIT] authentik written for ${targetId.slice(0, 8)}`);
    } else {
      this.logger.log(
        `[PROFILE_EDIT] ${targetId.slice(0, 8)}: authentik already holds this profile`
      );
    }

    try {
      return await this.dataSource.transaction(async (manager) => {
        Object.assign(user, {
          campus: after.campus,
          cursus: after.cursus,
          posts: after.posts,
          firstName: after.firstName,
          lastName: after.lastName,
          displayName: `${after.firstName} ${after.lastName}`,
          ...legacyColumns(after.cursus),
        });
        await manager.save(User, user);
        let changeId: string | null = null;
        if (!unchanged) {
          const change = await manager.save(
            ProfileChange,
            manager.create(ProfileChange, {
              userId: targetId,
              actorId,
              before,
              after,
              requestId: opts.requestId ?? null,
            })
          );
          changeId = change.id;
        }
        if (opts.requestId) {
          const answered = await manager.update(
            ProfileCorrectionRequest,
            { id: opts.requestId, status: 'pending' },
            { status: 'applied', resolvedAt: new Date(), resolvedBy: actorId }
          );
          if (answered.affected !== 1) throw new ProfileCorrectionNotPendingError();
        }
        return { user, changed: !unchanged, changeId };
      });
    } catch (err) {
      this.logger.error(
        `[PROFILE_EDIT] authentik was written for ${targetId.slice(0, 8)} but Canari's row and the ` +
          `audit were NOT (${String(err)}) - the sources disagree until the person's next sign-in`
      );
      throw err;
    }
  }
}

/**
 * A value serialized with every object's keys in a stable order, so two equal profiles compare
 * equal. Needed because authentik stores `attributes` as jsonb, which hands keys back in ITS order
 * (shortest first), not the order they were written in.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
