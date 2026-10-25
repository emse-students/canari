import { Logger } from '@nestjs/common';
import { In, type EntityManager } from 'typeorm';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { GroupMember } from '../entities/group-member.entity';
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
