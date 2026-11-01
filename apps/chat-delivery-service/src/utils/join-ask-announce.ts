import { Logger } from '@nestjs/common';
import { In, type EntityManager } from 'typeorm';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { GroupMember, isGroupUuid } from '../entities/group-member.entity';
import { Group } from '../entities/group.entity';
import { readGroupNotificationLevel } from '../services/notification-preferences';
import { resolveUserDisplayName } from './display-name';
import { isBlockedBetween } from './user-blocks';
import {
  type EvalCapable,
  JOIN_ASK_CAPABILITY,
  publishIfAddressable,
} from '../services/addressing';
import { ADMITTED_SEAT } from './group-membership';
import { cutUserId } from './log-repeat';

const logger = new Logger('JoinAsk');

/**
 * How an invitation-link ask ended, as every member's screen must learn it: a member's Add admitted
 * the person (`admitted`), a member declined or removed the seat (`declined`), nobody answered in
 * time (`expired`, `expireUnansweredAsks`), or the person withdrew their own seat (`withdrawn`).
 */
export type JoinAskOutcome = 'admitted' | 'declined' | 'expired' | 'withdrawn';

/**
 * ONE ASK, NAMED BY THE SEAT ITS LINK WROTE: `askId` is that roster row's id
 * (`dm_group_members.id`). A withdrawal deletes the row and following the link again writes a new
 * one, so an ask and a later ask of the same person never share an identity - which is what lets a
 * client settle an ask by identity and refuse a stale read of it, whatever order things arrive in.
 */
export interface AnsweredAsk {
  userId: string;
  askId: string;
}

/** The control frame that puts an ask before a member: "X asks to join this group". */
export interface JoinAskFrame {
  type: 'group.join_ask';
  data: { groupId: string; askId: string; requesterUserId: string; requesterDeviceIds: string[] };
}

/** The control frame that takes an ask off a member's screen, with the outcome the server holds. */
export interface JoinAskSettledFrame {
  type: 'group.join_ask.settled';
  data: { groupId: string; askId: string; userId: string; outcome: JoinAskOutcome };
}

/** The announcements started and not finished yet - see {@link joinAskAnnouncementsSettled}. */
const inFlight = new Set<Promise<void>>();

/**
 * Starts an announcement WITHOUT WAITING FOR IT: the caller's answer (an HTTP response, a commit
 * whose lock it holds) never waits on a roster read and a publish per member device. The work
 * catches and logs its own failures, so nothing here can reject.
 */
function dispatch(work: () => Promise<void>): void {
  const running = work().catch((e: unknown) => {
    logger.error(`[JOIN_ASK] announcement threw past its own guard: ${String(e)}`);
  });
  inFlight.add(running);
  void running.finally(() => inFlight.delete(running));
}

/**
 * Resolves once every announcement started so far - and every one THOSE started - has finished.
 * Nothing in the request path waits on it; it is what a test awaits instead of guessing how long a
 * publish takes.
 */
export async function joinAskAnnouncementsSettled(): Promise<void> {
  while (inFlight.size > 0) await Promise.all(inFlight);
}

/**
 * WHAT A RETIRING REPLICA STILL OWES (`drainOnSigterm`'s `beforeExit`, wired in `main.ts`): the
 * join-ask work in flight when the drain reaches it - a FIXED set, read once, so the wait is bounded
 * by work that already exists and never by work started later. Nothing starts from a request by
 * then (the listener is closed and every request answered), and the expiry cron runs its expiry and
 * its announcements as ONE tracked unit ({@link trackJoinAskWork}), so a SIGTERM that lands during it
 * waits for both. A publish that never returns is bounded by the release's own drain (`docker stop
 * --time`, `ROLLING_DRAIN_SECONDS` in `infrastructure/lib/rolling.sh`), which no code here
 * duplicates.
 */
export async function finishJoinAskWorkInFlight(): Promise<void> {
  const owed = [...inFlight];
  if (owed.length === 0) return;
  logger.log(`[JOIN_ASK] DRAIN finishing ${owed.length} announcement(s) before exit`);
  await Promise.all(owed);
}

/**
 * Runs `work` as tracked join-ask work and returns its result: a drain waits for it exactly as for
 * an announcement ({@link finishJoinAskWorkInFlight}). For work that DECIDES announcements and then
 * makes them - the expiry cron - so a shutdown between the two cannot lose them.
 */
export function trackJoinAskWork<T>(work: () => Promise<T>): Promise<T> {
  const running = work();
  // Tracked for its settlement only; its own caller sees (and logs) a rejection.
  const settled = running.then(
    () => undefined,
    () => undefined
  );
  inFlight.add(settled);
  void settled.finally(() => inFlight.delete(settled));
  return running;
}

/**
 * The devices an ask is told to, read from the roster and never from the routing set: every ACTIVE
 * device of every ADMITTED seat of `groupId` ({@link ADMITTED_SEAT}), the people in `exclude` aside.
 *
 * ADMITTED, BECAUSE ANSWERING IS A MEMBER'S GESTURE: a seat that itself awaits a member decides
 * nothing (the Decline route answers it 409), so it is not asked. ACTIVE, because only a device that
 * holds the group can Add. Whether each is online, and whether its code routes the frame, is the
 * publish's own check ({@link publishIfAddressable}).
 */
export async function admittedMemberDevices(
  m: EntityManager,
  groupId: string,
  exclude: readonly string[]
): Promise<Array<{ userId: string; deviceId: string }>> {
  const seats = await m.getRepository(GroupMember).find({
    where: { groupId, ...ADMITTED_SEAT },
    select: { userId: true },
  });
  const users = seats.map((s) => s.userId).filter((u) => !exclude.includes(u));
  if (users.length === 0) return [];
  return m.getRepository(DeviceGroupMembership).find({
    where: { groupId, userId: In(users), status: 'active' as const },
    select: { userId: true, deviceId: true },
  });
}

/**
 * Publishes one control frame to each device of {@link admittedMemberDevices} that is online AND
 * whose every session declared {@link JOIN_ASK_CAPABILITY}, the check and the publish in one script
 * per device ({@link publishIfAddressable}) - all of them sent at once on the one connection, so the
 * cost is one round trip, not one per device. The frame names the capability
 * (`requiresCapability`) so the gateway keeps it from a session that connected since without it: a
 * client that predates these frames never receives one, and its sweep shows the ask as before.
 *
 * Never thrown: the durable answer is the server's rows, which every member's sweep reads. A failure
 * is logged with the group, so a member who did not see an ask live is explained.
 *
 * @returns how many devices the frame was published to, or `null` when it could not be.
 */
async function publishToAdmittedMembers(
  m: EntityManager,
  redis: EvalCapable,
  groupId: string,
  exclude: readonly string[],
  frame: JoinAskFrame | JoinAskSettledFrame,
  sender: string
): Promise<number | null> {
  try {
    const targets = await admittedMemberDevices(m, groupId, exclude);
    const proto = Buffer.from(JSON.stringify(frame)).toString('base64');
    const published = await Promise.all(
      targets.map((t) =>
        publishIfAddressable(
          redis,
          t.userId,
          t.deviceId,
          {
            channel: 'chat:messages',
            payload: JSON.stringify({
              recipientId: t.userId,
              deviceId: t.deviceId,
              proto,
              isWelcomeRequest: true,
              requiresCapability: JOIN_ASK_CAPABILITY,
              groupId,
              senderId: sender,
            }),
          },
          JOIN_ASK_CAPABILITY
        )
      )
    );
    return published.filter(Boolean).length;
  } catch (e) {
    logger.warn(
      `[JOIN_ASK] ${frame.type} NOT announced group=${groupId} - members learn it at their next ` +
        `pending-invitation sweep: ${String(e)}`
    );
    return null;
  }
}

/**
 * TELLS EVERY ONLINE ADMITTED MEMBER, LIVE, THAT `requesterUserId` ASKS TO JOIN `groupId`.
 *
 * Any admitted member may answer (owner decision 2026-10-24), so the ask is put to all of them at
 * once - not to the ONE member the `welcome_request` election picks, which left every other member
 * learning of it only at their next sweep, minutes later. The election stays what it is for: which
 * device answers a relayed request mechanically.
 *
 * Started, never awaited ({@link dispatch}). One entry per ask on the client, by `askId`: the
 * elected member's `welcome_request` and the sweep raise the same ask.
 */
export function announceJoinAsk(
  m: EntityManager,
  redis: EvalCapable,
  groupId: string,
  ask: AnsweredAsk,
  requesterDeviceIds: readonly string[]
): void {
  dispatch(async () => {
    const sent = await publishToAdmittedMembers(
      m,
      redis,
      groupId,
      [ask.userId],
      {
        type: 'group.join_ask',
        data: {
          groupId,
          askId: ask.askId,
          requesterUserId: ask.userId,
          requesterDeviceIds: [...requesterDeviceIds],
        },
      },
      ask.userId
    );
    if (sent !== null) {
      logger.log(
        `[JOIN_ASK] ANNOUNCED group=${groupId} asker=${cutUserId(ask.userId)} ask=${ask.askId.slice(0, 8)} devices=${sent}`
      );
    }
  });
}

/**
 * Announces the asks the stale-pending purge expired (`expireUnansweredAsks`), each of which
 * committed in a transaction of its own - so a member's screen loses an ask nobody answered when the
 * server drops it, not at its next sweep. AWAITED, not dispatched: its one caller is the cron, which
 * answers nobody, and runs the expiry and this as one tracked unit ({@link trackJoinAskWork}).
 */
export async function announceExpiredAsks(
  m: EntityManager,
  redis: EvalCapable,
  expired: ReadonlyArray<{ groupId: string; userId: string; askId: string }>
): Promise<void> {
  for (const ask of expired) {
    await settleAsks(m, redis, ask.groupId, [ask], 'expired', '');
  }
}

/**
 * TAKES ASKS OFF EVERY ONLINE ADMITTED MEMBER'S SCREEN, with the outcome the server holds - so a
 * member who did not answer, or whose answer lost the race (two Adds, or an Add and a Decline the
 * seat lock ordered), settles on what happened without a refresh.
 *
 * Called only AFTER the transaction that decided it committed - and, on a commit, after its lock is
 * released: a frame announcing an outcome a rollback undid would take a live ask off every screen.
 * Started, never awaited ({@link dispatch}).
 */
export function announceJoinAskSettled(
  m: EntityManager,
  redis: EvalCapable,
  groupId: string,
  asks: readonly AnsweredAsk[],
  outcome: JoinAskOutcome,
  actor: string
): void {
  if (asks.length === 0) return;
  dispatch(() => settleAsks(m, redis, groupId, asks, outcome, actor));
}

/** Publishes the settlement of each of `asks`, one after the other; never thrown. */
async function settleAsks(
  m: EntityManager,
  redis: EvalCapable,
  groupId: string,
  asks: readonly AnsweredAsk[],
  outcome: JoinAskOutcome,
  actor: string
): Promise<void> {
  for (const ask of asks) {
    const sent = await publishToAdmittedMembers(
      m,
      redis,
      groupId,
      [ask.userId],
      {
        type: 'group.join_ask.settled',
        data: { groupId, askId: ask.askId, userId: ask.userId, outcome },
      },
      actor
    );
    if (sent !== null) {
      logger.log(
        `[JOIN_ASK] SETTLED group=${groupId} asker=${cutUserId(ask.userId)} ask=${ask.askId.slice(0, 8)} outcome=${outcome} devices=${sent}`
      );
    }
  }
}

/** The one push implementation (`MessagingService.sendPushToUser`), passed in so this file stays free of it. */
export type JoinAskPushSender = (
  userId: string,
  title: string,
  body: string,
  data: Record<string, string>
) => Promise<{ sent: number; failed: number }>;

/** The sentence key a device composes the push from (`composeServerNotification`, the NSE). */
export const JOIN_ASK_CONTENT_KEY = 'chat_join_ask';

/**
 * SENDS THE ONE ORDINARY, USER-VISIBLE PUSH PER ASK to the members already admitted: "X veut
 * rejoindre {group}" (owner, 2026-11-01). It is NOT the background-add wake, which an awaiting seat
 * suppresses on purpose (`notifyWelcomeRequest`): that wake lets a phone answer by itself, and no
 * push answers an ask. This one only tells a person, who answers by opening the app.
 *
 * ONE PER MEMBER DECLINE, FROM DURABLE STATE, AND THE JOINER CANNOT RE-ARM IT. The claim is a row
 * keyed `(groupId, userId)` (`dm_join_ask_pushes`, migration 043), not the seat: a self-withdrawal
 * deletes the seat and a re-follow writes a new one, so a claim on the seat let the joiner push every
 * member again and again. The row holds `gen`, the person's `declinedAtSeatGeneration` (0 when none),
 * a counter ONLY a member's Decline moves; the claim succeeds only for a strictly larger value. So
 * accept, withdraw, accept sends once; a Decline then a new ask sends again; an expiry re-arms
 * nothing. Two replicas race on the one INSERT ... ON CONFLICT and only one gets a row back.
 * At-most-once: a send that fails after the claim is logged, not retried. The push is NOT withdrawn
 * when the ask ends - an ordinary push cannot be recalled, and the card says the ask is over.
 *
 * NEVER TO THE JOINER, nor to a seat that itself awaits a member ({@link ADMITTED_SEAT}), nor to a
 * member for whom a block stands between them and the asker, in either direction. A member who muted
 * the conversation (`none`) is not pushed; the account's category switch is applied by the sender.
 * THE LOCK SCREEN NEVER SHOWS AN ID: with no resolvable name the actor is empty and the devices say
 * "Someone wants to join". Started, never awaited ({@link dispatch}).
 */
export function pushJoinAsk(
  m: EntityManager,
  groupId: string,
  ask: AnsweredAsk,
  push: JoinAskPushSender
): void {
  dispatch(async () => {
    const short = ask.askId.slice(0, 8);
    // A seat a member already answered is not an ask: nothing to tell anyone.
    const seat = await m.getRepository(GroupMember).findOne({
      where: { id: ask.askId, groupId, userId: ask.userId, awaitingAdmission: true },
      select: { id: true },
    });
    if (!seat) {
      logger.log(`[JOIN_ASK] push for ask=${short} not sent - the ask was already answered`);
      return;
    }
    const claimed: unknown[] = await m.query(
      `INSERT INTO dm_join_ask_pushes ("groupId", "userId", "gen")
       SELECT $1::uuid, $2::varchar,
              COALESCE((SELECT "declinedAtSeatGeneration" FROM dm_seat_evictions
                         WHERE "groupId" = $1::uuid AND "userId" = $2::varchar), 0)
       ON CONFLICT ("groupId", "userId") DO UPDATE SET "gen" = EXCLUDED."gen"
         WHERE dm_join_ask_pushes."gen" < EXCLUDED."gen"
       RETURNING 1`,
      [groupId, ask.userId]
    );
    if (claimed.length === 0) {
      logger.log(
        `[JOIN_ASK] push for ask=${short} not sent - this person's ask was already pushed and no member declined since`
      );
      return;
    }
    const seats = await m.getRepository(GroupMember).find({
      where: { groupId, ...ADMITTED_SEAT },
      select: { userId: true },
    });
    const recipients = [...new Set(seats.map((s) => s.userId))].filter((u) => u !== ask.userId);
    if (recipients.length === 0) {
      logger.log(`[JOIN_ASK] push for ask=${short} not sent - no admitted member to tell`);
      return;
    }
    const [asker, group] = await Promise.all([
      resolveUserDisplayName(m, ask.userId),
      m
        .getRepository(Group)
        .findOne({ where: { id: groupId }, select: { name: true, isGroup: true } }),
    ]);
    if (!asker) {
      // The lock screen must not show an id, so the devices say "Someone": accuse the lookup.
      logger.warn(
        `[JOIN_ASK] name of asker=${cutUserId(ask.userId)} not resolved for ask=${short} - pushed as "someone"`
      );
    }
    const groupName = group?.isGroup ? (group.name ?? '') : '';
    let sent = 0;
    let failed = 0;
    let muted = 0;
    let blocked = 0;
    for (const userId of recipients) {
      try {
        if (await isBlockedBetween(m, userId, ask.userId)) {
          blocked++;
          logger.log(
            `[JOIN_ASK] push to user=${cutUserId(userId)} skipped for ask=${short} - a block stands between them and the asker`
          );
          continue;
        }
        if (
          isGroupUuid(groupId) &&
          (await readGroupNotificationLevel(m, groupId, userId)) === 'none'
        ) {
          muted++;
          continue;
        }
        const result = await push(
          userId,
          asker || 'Canari',
          // Old clients, with no table for the key, show this; the device's own wording replaces it.
          `${asker || "Quelqu'un"} veut rejoindre ${groupName || 'la conversation'}`,
          {
            type: 'social',
            contentKey: JOIN_ASK_CONTENT_KEY,
            actorName: asker,
            contentArg: groupName,
            deepLink: `fr.emse.canari://chat/${groupId}`,
            groupId,
            // The asker, so the device can fetch their avatar.
            senderId: ask.userId,
          }
        );
        sent += result.sent;
        failed += result.failed;
      } catch (e) {
        // Per recipient: one member's failure never costs another their push.
        failed++;
        logger.warn(
          `[JOIN_ASK] push to user=${cutUserId(userId)} failed ask=${short}: ${String(e)}`
        );
      }
    }
    logger.log(
      `[JOIN_ASK] PUSHED group=${groupId} asker=${cutUserId(ask.userId)} ask=${short} sent=${sent} failed=${failed} muted=${muted} blocked=${blocked}`
    );
  });
}
