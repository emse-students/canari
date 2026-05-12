import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Inject,
  BadRequestException,
  ConflictException,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { Group } from '../entities/group.entity';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { GroupMember } from '../entities/group-member.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import {
  sanitizeQueryValue,
  sanitizeOptionalQueryValue,
} from '../utils/sanitize';

/** MLS group lifecycle: create, read, rename, delete, epoch management, bootstrap lock. */
@Controller()
export class GroupsController {
  private readonly logger = new Logger(GroupsController.name);

  constructor(
    @InjectRepository(Group) private groupRepo: Repository<Group>,
    @InjectRepository(DeviceGroupMembership)
    private deviceGroupRepo: Repository<DeviceGroupMembership>,
    @InjectRepository(QueuedMessage)
    private queuedMessageRepo: Repository<QueuedMessage>,
    @InjectRepository(GroupMember)
    private groupMemberRepo: Repository<GroupMember>,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  private makeTraceId(scope: string): string {
    return `${scope}-${crypto.randomUUID().slice(0, 8)}`;
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/groups')
  /** Creates a new MLS group record on the server. */
  async createGroup(
    @Body()
    body: {
      name: string;
      createdBy: string;
      isGroup?: boolean;
      creatorDeviceId?: string;
    },
  ) {
    const traceId = this.makeTraceId('create-grp');
    const groupId = uuidv4();
    this.logger.log(
      `[CREATE_GROUP][${traceId}] name="${body.name}" createdBy=${body.createdBy} isGroup=${body.isGroup ?? true} creatorDevice=${body.creatorDeviceId ?? 'none'} groupId=${groupId}`,
    );
    const newGroup = this.groupRepo.create({
      id: groupId,
      name: body.name,
      isGroup: body.isGroup ?? true,
    });
    await this.groupRepo.save(newGroup);

    // Mark the creator's device as welcome_received (they created the group locally)
    if (body.createdBy && body.creatorDeviceId) {
      const creatorMembership = this.deviceGroupRepo.create({
        userId: body.createdBy,
        deviceId: body.creatorDeviceId,
        groupId,
        status: 'welcome_received' as const,
        lastEpochSeen: 0,
      });
      await this.deviceGroupRepo.save(creatorMembership);
      this.logger.log(
        `[CREATE_GROUP][${traceId}] creator membership set to welcome_received`,
      );
    }

    this.logger.log(`[CREATE_GROUP][${traceId}] DONE groupId=${groupId}`);
    return {
      groupId,
      name: body.name,
      createdBy: body.createdBy,
      isGroup: newGroup.isGroup,
    };
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls/groups/:groupId')
  /** Retrieves metadata for a single group by its ID. */
  async getGroup(@Param('groupId') groupId: string) {
    const g = await this.groupRepo.findOne({ where: { id: groupId } });
    this.logger.log(`[GET_GROUP] groupId=${groupId} found=${!!g}`);
    return g ? { ...g, groupId: g.id } : null;
  }

  @UseGuards(HeaderAuthGuard)
  @Patch('mls/groups/:groupId')
  /** Renames a group. */
  async renameGroup(
    @Param('groupId') groupId: string,
    @Body() body: { name: string },
  ) {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    if (typeof body.name !== 'string' || !body.name.trim()) {
      throw new BadRequestException('name is required');
    }
    await this.groupRepo.update(
      { id: safeGroupId },
      { name: body.name.trim() },
    );
    this.logger.log(
      `[RENAME_GROUP] group=${safeGroupId} newName="${body.name.trim()}"`,
    );
    return { status: 'renamed' };
  }

  @UseGuards(HeaderAuthGuard)
  @Delete('mls/groups/:groupId')
  /** Deletes a group and all its server-side data (members, device memberships, queued messages). */
  async deleteGroup(@Param('groupId') groupId: string) {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    await this.groupRepo.delete({ id: safeGroupId });
    await this.groupMemberRepo.delete({ groupId: safeGroupId });
    await this.deviceGroupRepo.delete({ groupId: safeGroupId });
    await this.queuedMessageRepo.delete({ groupId: safeGroupId });
    await this.redis.del(`group:members:${safeGroupId}`);
    this.logger.log(`[DELETE_GROUP] group=${safeGroupId}`);
    return { status: 'deleted' };
  }

  /**
   * Reset a group's activeEpoch to 0.
   * Called during re-bootstrap when a new MLS session replaces the old one
   * for the same server groupId. Without this reset the first commit would
   * be rejected because the server still remembers the old epoch.
   */
  @UseGuards(HeaderAuthGuard)
  @Post('mls/groups/:groupId/reset-epoch')
  async resetGroupEpoch(@Param('groupId') groupId: string) {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    const group = await this.groupRepo.findOne({ where: { id: safeGroupId } });
    if (!group) {
      this.logger.warn(`[RESET_EPOCH] Group not found: ${safeGroupId}`);
      throw new BadRequestException(`Group ${safeGroupId} not found`);
    }
    const oldEpoch = group.activeEpoch;
    group.activeEpoch = 0;
    await this.groupRepo.save(group);
    this.logger.log(
      `[RESET_EPOCH] group=${safeGroupId} oldEpoch=${oldEpoch} → 0`,
    );
    return { groupId: safeGroupId, activeEpoch: 0 };
  }

  /**
   * ─── Bootstrap Optimistic Lock ───────────────────────────────────────
   *
   * Acquiert le verrou de re-bootstrap pour un groupe.
   * Utilise un optimistic lock sur `bootstrapVersion` pour garantir que seul
   * le premier device à appeler cette route peut recréer le groupe.
   *
   * - Succès (200) : bootstrapVersion incrémenté, ce device est le bootstrapper.
   * - 409 Conflict : un autre device a déjà incrémenté bootstrapVersion,
   *   le client doit annuler sa création locale et attendre le Welcome du gagnant.
   */
  @UseGuards(HeaderAuthGuard)
  @Post('mls/groups/:groupId/claim-bootstrap')
  async claimBootstrap(
    @Param('groupId') groupId: string,
    @Body() body: { expectedVersion: number },
  ) {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    const expectedVersion = Number(body?.expectedVersion ?? 0);

    const result = await this.groupRepo
      .createQueryBuilder()
      .update()
      .set({ bootstrapVersion: () => 'bootstrap_version + 1' })
      .where('id = :id AND bootstrap_version = :ev', {
        id: safeGroupId,
        ev: expectedVersion,
      })
      .execute();

    if (result.affected === 0) {
      this.logger.warn(
        `[BOOTSTRAP] claim-bootstrap race: group=${safeGroupId} expectedVersion=${expectedVersion}`,
      );
      throw new ConflictException(
        `Bootstrap already claimed for group ${safeGroupId}`,
      );
    }

    const group = await this.groupRepo.findOne({ where: { id: safeGroupId } });
    this.logger.log(
      `[BOOTSTRAP] claim-bootstrap OK: group=${safeGroupId} bootstrapVersion=${group?.bootstrapVersion}`,
    );
    return {
      groupId: safeGroupId,
      bootstrapVersion: group?.bootstrapVersion ?? expectedVersion + 1,
    };
  }

  /** Retourne la bootstrapVersion courante d'un groupe (pour l'optimistic lock). */
  @UseGuards(HeaderAuthGuard)
  @Get('mls/groups/:groupId/bootstrap-info')
  async getBootstrapInfo(@Param('groupId') groupId: string) {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    const group = await this.groupRepo.findOne({ where: { id: safeGroupId } });
    if (!group) {
      throw new BadRequestException(`Group ${safeGroupId} not found`);
    }
    return {
      groupId: safeGroupId,
      bootstrapVersion: group.bootstrapVersion ?? 0,
    };
  }

  /**
   * ─── Group Reset (hors-bande MLS) ────────────────────────────────────
   *
   * Signale à tous les appareils d'un groupe que la session MLS est morte
   * et doit être recréée from scratch. Contrairement au bootstrap client-side
   * qui écrasait unilatéralement le groupe (source de forks d'epoch),
   * ce reset est **orchestré par le serveur** :
   *
   *   1. Toutes les DeviceGroupMembership passent à "pending"
   *   2. L'epoch serveur est reset à 0
   *   3. Le set Redis group:members est vidé (plus de routage)
   *   4. **Un message WebSocket `group_reset` est diffusé** à tout appareil
   *      en ligne → chaque client fait forgetGroup() + isReady=false
   *   5. À la prochaine (re)connexion, chaque appareil enverra un
   *      welcome_request et sera ré-invité par le bootstrapper
   *
   * Le message `group_reset` est un signal hors-bande (non chiffré, pas de
   * dépendance MLS/KeyPackage). Il suit le même pattern que welcome_request
   * et reinvite_request : JSON sur Redis pub/sub → WebSocket.
   *
   * ⚠️ Modèle de menace : un serveur compromis pourrait forcer un reset.
   * C'est déjà le cas avec reinvite_request et la gestion des memberships —
   * le modèle fait confiance au serveur pour le routage.
   */
  @UseGuards(HeaderAuthGuard)
  @Post('mls/groups/:groupId/reset')
  async resetGroup(
    @Param('groupId') groupId: string,
    @Body() body: { reason?: string; triggeredBy?: string },
  ) {
    const traceId = this.makeTraceId('group-reset');
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    const reason = body.reason ?? 'bootstrap';
    const triggeredBy =
      sanitizeOptionalQueryValue(body.triggeredBy, 'triggeredBy') ?? 'unknown';

    const group = await this.groupRepo.findOne({
      where: { id: safeGroupId },
    });
    if (!group) {
      throw new BadRequestException(`Group ${safeGroupId} not found`);
    }

    this.logger.log(
      `[GROUP_RESET][${traceId}] START group=${safeGroupId} reason=${reason} triggeredBy=${triggeredBy} oldEpoch=${group.activeEpoch}`,
    );

    // ── 1. Reset toutes les memberships à "pending" ────────────────────
    // Chaque appareil devra être ré-invité via welcome_request.
    const memberships = await this.deviceGroupRepo.find({
      where: { groupId: safeGroupId },
    });
    for (const m of memberships) {
      m.status = 'pending';
      m.lastEpochSeen = 0;
    }
    if (memberships.length > 0) {
      await this.deviceGroupRepo.save(memberships);
    }
    this.logger.log(
      `[GROUP_RESET][${traceId}] ${memberships.length} membership(s) reset to pending`,
    );

    // ── 2. Reset epoch serveur ─────────────────────────────────────────
    group.activeEpoch = 0;
    await this.groupRepo.save(group);

    // ── 3. Vider le set Redis de routage ───────────────────────────────
    // Plus aucun appareil ne doit recevoir de messages MLS pour ce groupe
    // tant qu'il n'a pas été ré-invité.
    const redisKey = `group:members:${safeGroupId}`;
    const currentMembers: string[] = await this.redis.smembers(redisKey);
    if (currentMembers.length > 0) {
      await this.redis.del(redisKey);
    }
    this.logger.log(
      `[GROUP_RESET][${traceId}] Redis routing cleared (was ${currentMembers.length} member(s))`,
    );

    // ── 4. Notifier tous les appareils : online via WebSocket, offline via queue ──
    //
    // Le signal group_reset est éphémère (pub/sub). Un device offline ne le
    // recevrait jamais, arriverait avec un état MLS à l'epoch N et refuserait
    // silencieusement le Welcome de re-bootstrap (epoch 0). On persiste donc un
    // QueuedMessage { type:'group_reset' } pour chaque device offline : il sera
    // récupéré via fetchPendingMessages() et traité en tête de queue (priorité max)
    // AVANT le Welcome, garantissant que forgetGroup() est appelé d'abord.
    const notification = JSON.stringify({
      type: 'group_reset',
      groupId: safeGroupId,
      reason,
      triggeredBy,
    });

    // Pivot : membres récemment online (dans Redis routing) vs membres en DB (hors-ligne).
    const onlineSet = new Set(currentMembers); // "userId:deviceId" strings
    let notifiedOnline = 0;
    let notifiedOffline = 0;

    for (const m of memberships) {
      const memberKey = `${m.userId}:${m.deviceId}`;
      const onlineKey = `user:online:${m.userId}:${m.deviceId}`;
      const isOnline =
        onlineSet.has(memberKey) && (await this.redis.exists(onlineKey));

      if (isOnline) {
        // Device connecté : pub/sub temps-réel (path existant).
        await this.redis.publish(
          'chat:messages',
          JSON.stringify({
            recipientId: m.userId,
            deviceId: m.deviceId,
            proto: Buffer.from(notification).toString('base64'),
            groupId: safeGroupId,
          }),
        );
        notifiedOnline++;
      } else {
        // Device hors-ligne : persister un message de contrôle durable.
        // type='group_reset' est traité par processQueue() AVANT tout Welcome —
        // il ne passe pas par messageCallback (pas de bytes MLS à décrypter).
        await this.queuedMessageRepo.save(
          this.queuedMessageRepo.create({
            recipientId: m.userId,
            deviceId: m.deviceId,
            groupId: safeGroupId,
            type: 'group_reset',
            senderId: triggeredBy,
            proto: '', // Pas de payload MLS, juste un signal de contrôle
          }),
        );
        notifiedOffline++;
      }
    }

    this.logger.log(
      `[GROUP_RESET][${traceId}] DONE group=${safeGroupId} online=${notifiedOnline} offline_queued=${notifiedOffline} memberships=${memberships.length}`,
    );

    // ── Alerte de sécurité ────────────────────────────────────────────────
    // Un group_reset est un événement exceptionnel qui indique soit une perte
    // de données client (effacement app) soit un bug dans la gestion MLS.
    // On le logue avec un préfixe structuré filtrable et on envoie un webhook
    // optionnel (ALERT_WEBHOOK_URL, format Slack/Discord compatible).
    this.logger.warn(
      `[SECURITY_ALERT] group_reset triggered — group=${safeGroupId} reason=${reason} triggeredBy=${triggeredBy} ` +
        `memberships=${memberships.length} online=${notifiedOnline} offline_queued=${notifiedOffline}`,
    );
    void this.sendResetAlert(
      safeGroupId,
      reason,
      triggeredBy,
      memberships.length,
    );

    return {
      status: 'reset',
      groupId: safeGroupId,
      membershipsReset: memberships.length,
      notifiedOnline,
      notifiedOffline,
    };
  }

  /**
   * Fire-and-forget : envoie une alerte webhook quand un groupe est réinitialisé.
   * Configuré via ALERT_WEBHOOK_URL (format Slack incoming webhook ou Discord
   * avec /slack en suffix). Silencieux si la variable n'est pas définie.
   */
  private async sendResetAlert(
    groupId: string,
    reason: string,
    triggeredBy: string,
    memberCount: number,
  ): Promise<void> {
    const webhookUrl = process.env.ALERT_WEBHOOK_URL;
    if (!webhookUrl) return;
    try {
      const body = JSON.stringify({
        text: `⚠️ *Group Reset* — \`${groupId}\``,
        attachments: [
          {
            color: 'warning',
            fields: [
              { title: 'Raison', value: reason, short: true },
              { title: 'Déclenché par', value: triggeredBy, short: true },
              { title: 'Membres', value: String(memberCount), short: true },
              { title: 'Heure', value: new Date().toISOString(), short: true },
            ],
          },
        ],
      });
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(5_000),
      });
    } catch (e) {
      this.logger.warn(`[SECURITY_ALERT] Webhook delivery failed: ${e}`);
    }
  }
}
