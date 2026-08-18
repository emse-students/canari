import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PlatformAnnouncement } from './entities/platform-announcement.entity';
import { PlatformAnnouncementSeen } from './entities/platform-announcement-seen.entity';
import { PublishAnnouncementDto } from './dto/publish-announcement.dto';
import { versionInRange } from './semver';

/** What a client is handed: both languages, so the reader's own layer picks. */
export type AnnouncementForClient = {
  id: string;
  titleFr: string;
  titleEn: string;
  bodyFr: string;
  bodyEn: string;
};

/** What the admin panel reads back: the announcement plus how far it has travelled. */
export type AnnouncementForAdmin = AnnouncementForClient & {
  minClientVersion: string | null;
  maxClientVersion: string | null;
  createdAt: Date;
  createdBy: string;
  /** How many accounts have seen it. The only reason anyone asks whether it worked. */
  seenCount: number;
};

/**
 * The one active announcement, who has seen it, and who it applies to.
 *
 * Publishing writes a row rather than a deploy, exactly as `minClientVersion` does: an announcement
 * that needs a release to go out is an announcement that arrives after the thing it announces.
 */
@Injectable()
export class AnnouncementService {
  private readonly logger = new Logger(AnnouncementService.name);

  constructor(
    @InjectRepository(PlatformAnnouncement)
    private readonly repo: Repository<PlatformAnnouncement>,
    @InjectRepository(PlatformAnnouncementSeen)
    private readonly seenRepo: Repository<PlatformAnnouncementSeen>
  ) {}

  /**
   * The announcement this account should be shown right now, or `null`.
   *
   * Three reasons for `null`, and the caller is told apart from none of them ON PURPOSE: there is no
   * active announcement, this account has already seen it, or this client's version is outside the
   * range. The range is a filter, so a client outside it must not learn that something exists and
   * was withheld - it simply has nothing.
   *
   * @param userId account asking, from `x-user-id`
   * @param clientVersion the caller's own `major.minor.patch`; anything unreadable yields `null`
   */
  async getForUser(userId: string, clientVersion: string): Promise<AnnouncementForClient | null> {
    const active = await this.repo.findOne({ where: { active: true } });
    if (!active) return null;

    if (!versionInRange(clientVersion, active.minClientVersion, active.maxClientVersion)) {
      this.logger.debug(
        `[ANNOUNCEMENT] out of range user=${userId.slice(0, 8)} client=${clientVersion} ` +
          `range=[${active.minClientVersion ?? '*'},${active.maxClientVersion ?? '*'}]`
      );
      return null;
    }

    const seen = await this.seenRepo.findOne({
      where: { announcementId: active.id, userId },
    });
    if (seen) return null;

    return toClient(active);
  }

  /**
   * Records that this account has seen this announcement, once and for all.
   *
   * Idempotent by the primary key (announcement, user) rather than by reading first: two devices
   * that opened the app in the same second both write, and the second one must be a no-op instead
   * of a duplicate-key error the client would treat as "not dismissed".
   *
   * Accepts an id that is not the active one without complaint - an announcement replaced while a
   * modal was open on somebody's screen is an ordinary race, and the honest answer is to record
   * what they actually saw.
   */
  async markSeen(userId: string, announcementId: string): Promise<void> {
    await this.seenRepo
      .createQueryBuilder()
      .insert()
      .values({ announcementId, userId })
      .orIgnore()
      .execute();
    this.logger.debug(
      `[ANNOUNCEMENT] seen announcement=${announcementId} user=${userId.slice(0, 8)}`
    );
  }

  /** The active announcement for the admin panel, with its reach. `null` when none is published. */
  async getActiveForAdmin(): Promise<AnnouncementForAdmin | null> {
    const active = await this.repo.findOne({ where: { active: true } });
    if (!active) return null;
    const seenCount = await this.seenRepo.count({ where: { announcementId: active.id } });
    return { ...toClient(active), ...toAdmin(active), seenCount };
  }

  /**
   * Publishes a new announcement and retires whatever was active.
   *
   * Retire-then-insert in ONE transaction, because the partial unique index that keeps "at most one
   * active" true would otherwise reject the insert while the old row still stands - and because a
   * window with zero active announcements is a window in which someone opens the app and is shown
   * nothing at all.
   *
   * A new row rather than an edit of the old one, deliberately: the "seen" rows are keyed by
   * announcement id, so editing in place would show the new text to nobody who had seen the old.
   */
  async publish(dto: PublishAnnouncementDto, actorUserId: string): Promise<AnnouncementForAdmin> {
    const created = await this.repo.manager.transaction(async (tx) => {
      await tx.getRepository(PlatformAnnouncement).update({ active: true }, { active: false });
      return tx.getRepository(PlatformAnnouncement).save({
        titleFr: dto.titleFr.trim(),
        titleEn: dto.titleEn.trim(),
        bodyFr: dto.bodyFr.trim(),
        bodyEn: dto.bodyEn.trim(),
        minClientVersion: normalizeBound(dto.minClientVersion),
        maxClientVersion: normalizeBound(dto.maxClientVersion),
        active: true,
        createdBy: actorUserId,
      });
    });

    this.logger.log(
      `[ANNOUNCEMENT] published id=${created.id} by=${actorUserId.slice(0, 8)} ` +
        `range=[${created.minClientVersion ?? '*'},${created.maxClientVersion ?? '*'}]`
    );
    return { ...toClient(created), ...toAdmin(created), seenCount: 0 };
  }

  /**
   * Retires the active announcement so nobody else is shown it.
   *
   * The row and its "seen" rows are kept: they are the record of who was told what, and deleting
   * them would make a re-publication of the same text reappear for people who had already read it.
   */
  async retire(actorUserId: string): Promise<void> {
    const active = await this.repo.findOne({ where: { active: true } });
    if (!active) throw new NotFoundException('No active announcement');
    await this.repo.update({ id: active.id }, { active: false });
    this.logger.log(`[ANNOUNCEMENT] retired id=${active.id} by=${actorUserId.slice(0, 8)}`);
  }
}

/** An empty or blank bound means "no bound", never the empty string. */
function normalizeBound(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

function toClient(row: PlatformAnnouncement): AnnouncementForClient {
  return {
    id: row.id,
    titleFr: row.titleFr,
    titleEn: row.titleEn,
    bodyFr: row.bodyFr,
    bodyEn: row.bodyEn,
  };
}

function toAdmin(
  row: PlatformAnnouncement
): Omit<AnnouncementForAdmin, keyof AnnouncementForClient | 'seenCount'> {
  return {
    minClientVersion: row.minClientVersion,
    maxClientVersion: row.maxClientVersion,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  };
}
