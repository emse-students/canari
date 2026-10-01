import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AssociationDocument } from './entities/association-document.entity';
import { applyMediaRetentionClass } from '../internal/media-retention-class';

/**
 * Keeps every association vault document's blob in the media service's `association` class.
 *
 * WHY IT EXISTS: in 2026-09 an association's vault document was deleted on production by the media
 * service's idle sweep. The document row stayed, the vault key answered, and the download answered
 * 410. The upload had named no retention class, and the sweep then took every idle object that no
 * exemption named. The sweep is an allowlist now, and the client names `association` at upload -
 * this is the third leg, for what neither covers: documents uploaded before the class existed,
 * uploads from an installed client too old to send it, and an index rebuilt after a loss (the
 * media index is a JSON file, and a lost entry comes back with no class).
 *
 * `association` rather than `archive` because the two differ on account deletion: a feed photo
 * goes with its uploader's account, a vault document belongs to the association and must survive
 * the officer who happened to upload it.
 *
 * Best-effort and logged, like every retention call: a failure here leaves the object unclassified,
 * which the allowlisted sweep keeps anyway, and the next boot re-applies it.
 */
@Injectable()
export class AssociationDocumentRetentionService implements OnModuleInit {
  private readonly logger = new Logger(AssociationDocumentRetentionService.name);

  constructor(
    private readonly httpService: HttpService,
    @InjectRepository(AssociationDocument)
    private readonly docRepo: Repository<AssociationDocument>
  ) {}

  /** Re-applies `association` to every document blob, once per boot. Idempotent, one query. */
  async onModuleInit(): Promise<void> {
    const rows = await this.docRepo
      .createQueryBuilder('d')
      .select('DISTINCT d.mediaId', 'mediaId')
      .getRawMany<{ mediaId: string | null }>();
    const ids = rows.map((r) => r.mediaId).filter((id): id is string => typeof id === 'string');
    if (ids.length === 0) {
      this.logger.log('Vault retention backfill: no association document');
      return;
    }
    const changed = await this.classify(ids);
    // 0 is the steady state; anything else means an object had no class and this put it back.
    this.logger.log(
      changed === null
        ? `Vault retention backfill FAILED for ${ids.length} document(s) - retried at the next boot`
        : `Vault retention backfill: ${ids.length} document(s), ${changed} newly classified`
    );
  }

  /**
   * Classifies document blobs as `association`.
   *
   * @returns the number of entries the media service changed, or `null` if a batch failed.
   */
  classify(mediaIds: string[]): Promise<number | null> {
    if (mediaIds.length === 0) return Promise.resolve(0);
    return applyMediaRetentionClass(this.httpService, this.logger, mediaIds, 'association');
  }
}
