import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { acceptedFollowSql } from '../follows/follow-status';
import { PostNotificationsService } from '../posts/post-notifications.service';
import { liveVisibleToUserSql } from '../spaces/reader-spaces';
import { isLiveEnabled } from './live-enabled.guard';
import { LIVE_MIN_CLIENT_VERSION } from './live-client-version';
import { short } from './live-log';

/** Short form of an id for a log line. */

/**
 * Who is told that a live started (decision L10): the broadcaster's FOLLOWERS - the ACCEPTED
 * `user_follows` rows for a member's live (a pending request is not a follow, WP-F1),
 * `association_follows` for a live broadcast as an association - minus the
 * broadcaster, minus a follower who cannot SEE it (`liveVisibleToUserSql`: the rule of a post by the
 * same author or association, so a member's live reaches every ACCEPTED follower whatever their
 * space since WP-F5, and an association's live only the followers its audience reaches),
 * minus either side of a block with the broadcaster, minus a viewer the broadcaster already removed.
 * Exactly the accounts `LivesService.assertMayWatch` would let in (read grants aside, which never
 * notify), narrowed to the followers: a push never points at a live its reader would get a 404 or a
 * 403 for.
 *
 * `association_push_mutes` is NOT read here: the mute silences the PUSH and is applied by
 * `PostNotificationsService`, the one place that pushes (`MUTABLE_PUSH_TYPES`). The reader's own
 * category switch ("posts") is applied by chat-delivery, from the push's `contentKey`.
 *
 * Parameters: `$1` the broadcaster, `$2` the live, `$3` the association (association lives only).
 */
export function liveAudienceSql(asAssociation: boolean): string {
  const followers = asAssociation
    ? `SELECT f."followerUserId" AS id FROM association_follows f WHERE f."associationId" = $3`
    : `SELECT f."followerUserId" AS id FROM user_follows f
         WHERE f."followedUserId" = $1 AND ${acceptedFollowSql('f')}`;
  // The visibility predicate is the PLAIN one (no read grant), as for a post's announcement: a named
  // reader is never notified for their perimeter.
  return `SELECT DISTINCT fw.id FROM (${followers}) fw
    JOIN users fw_user ON fw_user.id = fw.id
    JOIN lives fw_live ON fw_live.id = $2
    WHERE fw.id <> $1
      AND ${liveVisibleToUserSql('fw_live', 'fw_user')}
      AND NOT EXISTS (SELECT 1 FROM user_blocks b
                       WHERE (b."blockerId" = $1 AND b."blockedId" = fw.id)
                          OR (b."blockerId" = fw.id AND b."blockedId" = $1))
      AND NOT EXISTS (SELECT 1 FROM live_removed_viewers r
                       WHERE r."liveId" = $2 AND r."viewerId" = fw.id)`;
}

/** What a claimed live needs to be announced. */
export interface ClaimedLive {
  broadcasterId: string;
  associationId: string | null;
}

/**
 * "X est en live": ONE push per live to the broadcaster's followers (WP-L7, decisions L5 and L10;
 * docs/wiki/services/lives.md).
 *
 * WHEN: at the first STORED segment, not at `POST /api/lives`. A live row alone has nothing to
 * watch - a start the client abandons (camera refused, the app killed, the broadcaster ending at
 * once) would ring every follower for a live that never showed a frame. The first confirmed segment
 * is the first moment a follower who taps finds something, so a live refused at its start, or ended
 * before its first segment, is never announced.
 *
 * IDEMPOTENCE IS `announcedAt` AND NOTHING ELSE - not a window, not a timer. The CLAIM is written by
 * `LivesService.confirm` IN THE SAME TRANSACTION, under the same row lock, as segment 0 itself
 * (`"announcedAt" IS NULL` is the condition), so "this live has a frame" and "this live is
 * claimed for its announcement" are one commit: no second writer can claim it, a reconnect continues
 * the same stamped row, and nothing needs a sweep to reconcile two paths. The send follows the
 * commit - the trade `PostAnnounceScheduler` documents: a crash between the two loses ONE
 * announcement, where the other order could repeat it.
 *
 * Nothing is sent unless `LIVE_ENABLED` is `true`, whoever calls (the ingest route that claims is
 * itself behind the same switch, and behind `lives_mode` too).
 *
 * In-app: NO bell row. A live is deleted when it ends (L3), so a row naming it would be a 404 for
 * ever after; the LIVE card at the top of the feed (L5, client-side, still owed) is its in-app face.
 */
@Injectable()
export class LiveAnnouncer {
  private readonly logger = new Logger(LiveAnnouncer.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly notifications: PostNotificationsService
  ) {}

  /**
   * Pushes a CLAIMED live's start to its broadcaster's followers, and NEVER throws: a failure is
   * logged, and the live is not retried (its claim is committed). Returns how many followers were
   * addressed, or `null` when nothing was sent (switched off, or a failure).
   */
  async announce(liveId: string, live: ClaimedLive): Promise<number | null> {
    if (!isLiveEnabled()) {
      this.logger.debug(`[LIVE_ANNOUNCE] ${liveId} not announced: LIVE_ENABLED is off`);
      return null;
    }
    try {
      return await this.send(liveId, live);
    } catch (e) {
      // Per live, and loud: the claim is committed, so this live is never announced.
      this.logger.warn(
        `[LIVE_ANNOUNCE] ${liveId} NOT announced: ${e instanceof Error ? e.message : String(e)}`
      );
      return null;
    }
  }

  /** Reads the audience and the broadcaster's name, then hands the push to the one pipeline. */
  private async send(liveId: string, live: ClaimedLive): Promise<number> {
    const asAssociation = live.associationId !== null;
    const params = asAssociation
      ? [live.broadcasterId, liveId, live.associationId]
      : [live.broadcasterId, liveId];
    const rows: { id: string }[] = await this.db.query(liveAudienceSql(asAssociation), params);
    const recipientIds = rows.map((r) => String(r.id));

    let actorName: string;
    let associationLogoMediaId: string | null = null;
    if (asAssociation) {
      const assos: { name: string | null; logoMediaId: string | null }[] = await this.db.query(
        `SELECT name, "logoMediaId" FROM associations WHERE id = $1`,
        [live.associationId]
      );
      actorName = String(assos[0]?.name ?? '');
      // Not a fallback into a generic sentence: an association with no name is a broken row (or one
      // deleted during the live), and announcing it as nobody would hide that.
      if (!actorName) throw new Error(`association ${live.associationId} has no name`);
      associationLogoMediaId = assos[0]?.logoMediaId ?? null;
    } else {
      // NOT `resolveActorName`, which falls back to the raw user id: a lock screen reading
      // "<64 hex> est en live" is a fault shown to every follower. An unnamed broadcaster is refused
      // here; a lookup that FAILED throws from `resolveDisplayName` itself, with its own cause. Either
      // way `announce` logs the one line, at warn, that says which.
      const name = await this.notifications.resolveDisplayName(live.broadcasterId);
      if (!name) throw new Error(`broadcaster ${short(live.broadcasterId)} has no display name`);
      actorName = name;
    }

    const addressed = await this.notifications.pushNotice({
      recipientIds,
      type: 'live_started',
      actorId: live.broadcasterId,
      actorName,
      text: '',
      ...(asAssociation ? { associationId: live.associationId as string } : {}),
      associationLogoMediaId,
      pushData: {
        liveId,
        // The lives floor (a build below it answers every /lives call with a 404): chat-delivery
        // skips a device KNOWN to run an older build, and strips this key before sending.
        minAppVersion: LIVE_MIN_CLIENT_VERSION,
        ...(asAssociation ? { associationId: live.associationId as string } : {}),
      },
    });
    this.logger.log(
      `[LIVE_ANNOUNCE] ${liveId} by ${short(live.broadcasterId)} ` +
        `kind=${asAssociation ? 'association' : 'member'} followers=${addressed}`
    );
    return addressed;
  }
}
