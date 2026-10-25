import { Logger } from '@nestjs/common';
import { In, type EntityManager } from 'typeorm';
import type Redis from 'ioredis';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { GroupMember } from '../entities/group-member.entity';
import { ADMITTED_SEAT } from './group-membership';
import { cutUserId } from './log-repeat';

const logger = new Logger('JoinAsk');

/** The presence key of ONE device: the gateway writes it on connect and lets it expire. */
export function devicePresenceKey(userId: string, deviceId: string): string {
  return `user:online:${userId}:${deviceId}`;
}

/**
 * How an invitation-link ask ended, as every member's screen must learn it: a member's Add admitted
 * the person (`admitted`), or a member's Decline withdrew the seat (`declined`).
 */
export type JoinAskOutcome = 'admitted' | 'declined';

/** The control frame that puts an ask before a member: "X asks to join this group". */
export interface JoinAskFrame {
  type: 'group.join_ask';
  data: { groupId: string; requesterUserId: string; requesterDeviceIds: string[] };
}

/** The control frame that takes an ask off a member's screen, with the outcome the server holds. */
export interface JoinAskSettledFrame {
  type: 'group.join_ask.settled';
  data: { groupId: string; userId: string; outcome: JoinAskOutcome };
}

/**
 * The devices an ask is told to, read from the roster and never from the routing set: every ACTIVE
 * device of every ADMITTED seat of `groupId` ({@link ADMITTED_SEAT}), the people in `exclude`
 * aside, that is online now.
 *
 * ADMITTED, BECAUSE ANSWERING IS A MEMBER'S GESTURE: a seat that itself awaits a member decides
 * nothing (the Decline route answers it 409), so it is not asked. ACTIVE, because only a device that
 * holds the group can Add. ONLINE, because the frame is live-only: a member who connects later reads
 * the same ask from its pending-invitation sweep, which is the durable source (`pending` rows).
 */
export async function onlineAdmittedDevices(
  m: EntityManager,
  redis: Pick<Redis, 'exists'>,
  groupId: string,
  exclude: readonly string[]
): Promise<Array<{ userId: string; deviceId: string }>> {
  const seats = await m.getRepository(GroupMember).find({
    where: { groupId, ...ADMITTED_SEAT },
    select: { userId: true },
  });
  const users = seats.map((s) => s.userId).filter((u) => !exclude.includes(u));
  if (users.length === 0) return [];
  const devices = await m.getRepository(DeviceGroupMembership).find({
    where: { groupId, userId: In(users), status: 'active' as const },
    select: { userId: true, deviceId: true },
  });
  const online: Array<{ userId: string; deviceId: string }> = [];
  for (const d of devices) {
    if (await redis.exists(devicePresenceKey(d.userId, d.deviceId))) {
      online.push({ userId: d.userId, deviceId: d.deviceId });
    }
  }
  return online;
}

/**
 * Publishes one control frame to each device of {@link onlineAdmittedDevices}, ONCE per device,
 * over the gateway's generic control path (`isWelcomeRequest` is that flag's name; the frame's own
 * `type` is what drives the client).
 *
 * Best-effort and never thrown: the durable answer is the server's rows, which every member's sweep
 * reads. A failure is logged with the group, so a member who did not see an ask live is explained.
 *
 * @returns how many devices the frame was published to, or `null` when it could not be.
 */
async function publishToAdmittedMembers(
  m: EntityManager,
  redis: Pick<Redis, 'exists' | 'publish'>,
  groupId: string,
  exclude: readonly string[],
  frame: JoinAskFrame | JoinAskSettledFrame,
  sender: string
): Promise<number | null> {
  try {
    const targets = await onlineAdmittedDevices(m, redis, groupId, exclude);
    const proto = Buffer.from(JSON.stringify(frame)).toString('base64');
    for (const t of targets) {
      await redis.publish(
        'chat:messages',
        JSON.stringify({
          recipientId: t.userId,
          deviceId: t.deviceId,
          proto,
          isWelcomeRequest: true,
          groupId,
          senderId: sender,
        })
      );
    }
    return targets.length;
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
 * (the owner with the conversation open included) learning of it only at their next sweep, minutes
 * later (measured on dev, 2026-10-25). The election stays what it is for: which device answers a
 * relayed request mechanically.
 *
 * Idempotent on the client by (group, person): the elected member also raises the ask from its
 * `welcome_request`, and the sweep raises it again from the `pending` rows - one entry either way.
 */
export async function announceJoinAsk(
  m: EntityManager,
  redis: Pick<Redis, 'exists' | 'publish'>,
  groupId: string,
  requesterUserId: string,
  requesterDeviceIds: readonly string[]
): Promise<void> {
  const sent = await publishToAdmittedMembers(
    m,
    redis,
    groupId,
    [requesterUserId],
    {
      type: 'group.join_ask',
      data: { groupId, requesterUserId, requesterDeviceIds: [...requesterDeviceIds] },
    },
    requesterUserId
  );
  if (sent !== null) {
    logger.log(
      `[JOIN_ASK] ANNOUNCED group=${groupId} asker=${cutUserId(requesterUserId)} devices=${sent} - every online admitted member`
    );
  }
}

/**
 * TAKES AN ASK OFF EVERY ONLINE ADMITTED MEMBER'S SCREEN, with the outcome the server holds - so a
 * member who did not answer, or whose answer lost the race (two Adds, or an Add and a Decline the
 * seat lock ordered), settles on what happened without a refresh.
 *
 * Called AFTER the transaction that decided it committed, never inside it: a frame announcing an
 * outcome a rollback undid would take a live ask off every screen.
 */
export async function announceJoinAskSettled(
  m: EntityManager,
  redis: Pick<Redis, 'exists' | 'publish'>,
  groupId: string,
  userIds: readonly string[],
  outcome: JoinAskOutcome,
  actor: string
): Promise<void> {
  for (const userId of new Set(userIds)) {
    const sent = await publishToAdmittedMembers(
      m,
      redis,
      groupId,
      [userId],
      { type: 'group.join_ask.settled', data: { groupId, userId, outcome } },
      actor
    );
    if (sent !== null) {
      logger.log(
        `[JOIN_ASK] SETTLED group=${groupId} asker=${cutUserId(userId)} outcome=${outcome} devices=${sent}`
      );
    }
  }
}
