import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DeviceSignatureKey } from '../entities/device-signature-key.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { readKeyPackageLeaf } from '../utils/key-package-leaf';

/** Which upload a batch of KeyPackages came from - named in every log line so a refusal is placed. */
export type KeyPackageSource = 'register-device' | 'prekeys';

/**
 * The durable history of every device's MLS signature keys (see {@link DeviceSignatureKey}).
 *
 * ONE writer and ONE reader, so the rule "a key is recorded only when its credential names the
 * device that uploaded it" is written once.
 */
@Injectable()
export class DeviceSignatureKeysService {
  private readonly logger = new Logger(DeviceSignatureKeysService.name);

  constructor(
    @InjectRepository(DeviceSignatureKey)
    private readonly keyRepo: Repository<DeviceSignatureKey>,
    @InjectRepository(KeyPackage)
    private readonly keyPackageRepo: Repository<KeyPackage>
  ) {}

  /**
   * Records the signature keys carried by a batch of KeyPackages a device is uploading.
   *
   * Called BEFORE the packages are stored, so a failure here fails the upload and the client's retry
   * re-sends the same batch - rather than a stored pool whose key history is missing, which nothing
   * would ever retry.
   *
   * A batch holding ANY package that does not parse, or whose credential names ANOTHER device, is
   * REFUSED whole, and nothing of it is stored. A package naming someone else is what a member
   * would add to a group as that someone else - the server was the only party placed to stop it
   * before it reached a tree, and it did not look. MEASURED BEFORE REFUSED, 2026-09-29: every stored
   * package on both estates (production 38 525 over 870 devices, dev 38 177 over 857) parsed and
   * named its uploader, and every device carried exactly one key - so no shipped client trips it.
   */
  async record(
    userId: string,
    deviceId: string,
    keyPackages: string[],
    source: KeyPackageSource
  ): Promise<void> {
    const expected = `${userId}:${deviceId}`;
    const keys = new Set<string>();
    let unreadable = 0;
    let foreign = 0;
    for (const keyPackage of keyPackages) {
      const leaf = readKeyPackageLeaf(keyPackage);
      if (!leaf) unreadable++;
      else if (leaf.identity !== expected) foreign++;
      else keys.add(leaf.signatureKey);
    }
    if (unreadable > 0 || foreign > 0) {
      this.logger.error(
        `[DEVICE_KEY] REFUSED source=${source} user=${userId} device=${deviceId}` +
          ` unreadable=${unreadable} foreignIdentity=${foreign} of=${keyPackages.length}`
      );
      // The code is what a client classifies on; both arms share it because both mean "this client
      // minted something no member may add", and neither is retryable.
      throw new BadRequestException({
        code: 'KEY_PACKAGE_IDENTITY_INVALID',
        message: 'Every key package must parse and name the device uploading it',
        unreadable,
        foreignIdentity: foreign,
      });
    }

    const inserted = await this.keyRepo
      .createQueryBuilder()
      .insert()
      .into(DeviceSignatureKey)
      .values([...keys].map((signatureKey) => ({ userId, deviceId, signatureKey })))
      .orIgnore()
      .returning(['id'])
      .execute();
    // Only a NEW key is worth a line: the same key arrives with every pool refill, and a line per
    // refill is one its reader learns to skip.
    const fresh = Array.isArray(inserted.raw) ? inserted.raw.length : 0;
    if (fresh > 0) {
      this.logger.log(
        `[DEVICE_KEY] RECORDED source=${source} user=${userId} device=${deviceId} new=${fresh}`
      );
    }
  }

  /**
   * Every signature key the device has published, oldest first: the history, plus the key in its
   * CURRENT static KeyPackage, which is what answers for a device that has uploaded nothing since
   * the history began (migration 027 has no backfill for that reason).
   */
  async keysFor(userId: string, deviceId: string): Promise<string[]> {
    const rows = await this.keyRepo.find({
      where: { userId, deviceId },
      order: { firstSeenAt: 'ASC' },
    });
    const keys = rows.map((row) => row.signatureKey);
    const current = await this.keyPackageRepo.findOne({ where: { userId, deviceId } });
    if (current) {
      const leaf = readKeyPackageLeaf(current.keyPackage);
      if (leaf?.identity === `${userId}:${deviceId}`) {
        if (!keys.includes(leaf.signatureKey)) keys.push(leaf.signatureKey);
      } else {
        this.logger.error(
          `[DEVICE_KEY] current key package unreadable or foreign user=${userId} device=${deviceId}`
        );
      }
    }
    this.logger.debug(`[DEVICE_KEY] served user=${userId} device=${deviceId} keys=${keys.length}`);
    return keys;
  }
}
