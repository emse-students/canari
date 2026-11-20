/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, InternalServerErrorException, Logger } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ThrottlerGuard } from '@nestjs/throttler';
import { UserThrottlerGuard } from '../guards/user-throttler.guard';
import { ClientIpThrottlerGuard } from '../guards/client-ip-throttler.guard';
import { LEGACY_UNSALTED_VERIFIER, SecurityController } from './security.controller';
import { PinVerifier } from '../entities/pin-verifier.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { MessagingService } from '../services/messaging.service';

describe('SecurityController - checkPinVerifier', () => {
  let controller: SecurityController;
  let pinVerifierRepo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let revokedDeviceRepo: {
    findOne: jest.Mock;
    delete: jest.Mock;
  };

  beforeEach(async () => {
    pinVerifierRepo = {
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    revokedDeviceRepo = {
      findOne: jest.fn(),
      delete: jest.fn(),
    };

    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SecurityController],
      providers: [
        { provide: getRepositoryToken(PinVerifier), useValue: pinVerifierRepo },
        { provide: getRepositoryToken(RevokedDevice), useValue: revokedDeviceRepo },
        { provide: getRepositoryToken(KeyPackage), useValue: {} },
        { provide: MessagingService, useValue: {} },
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(UserThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ClientIpThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(SecurityController);
  });

  /**
   * The FIRST verifier is one conditional write, and only on a creation the client declared
   * (PIN audit, 2026-11-20): a keypad drawn as "unlock" by mistake must not store an unconfirmed PIN,
   * and two devices creating at once must not both be told `registered`.
   */
  it('fills the placeholder row with a conditional update, and answers registered', async () => {
    pinVerifierRepo.findOne.mockResolvedValue({ id: 'p', userId: 'u1', verifier: '', salt: 's' });
    pinVerifierRepo.update.mockResolvedValue({ affected: 1 });

    const result = await controller.checkPinVerifier(
      { userId: 'u1', verifier: 'a'.repeat(64), salt: 's', intent: 'create' },
      'u1'
    );

    // Pinned to the row that was READ, never "whatever placeholder this user has now".
    expect(pinVerifierRepo.update).toHaveBeenCalledWith(
      { id: 'p', verifier: '' },
      { verifier: 'a'.repeat(64) }
    );
    expect(pinVerifierRepo.save).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'registered', resetRequired: false });
  });

  it('a write that lost to a reset (the row re-minted under another id) answers stale-salt', async () => {
    pinVerifierRepo.findOne
      .mockResolvedValueOnce({ id: 'p', userId: 'u1', verifier: '', salt: 's' })
      .mockResolvedValueOnce({ id: 'q', userId: 'u1', verifier: '', salt: 's2' });
    pinVerifierRepo.update.mockResolvedValue({ affected: 0 });

    await expect(
      controller.checkPinVerifier(
        { userId: 'u1', verifier: 'a'.repeat(64), salt: 's', intent: 'create' },
        'u1'
      )
    ).resolves.toEqual({ status: 'stale-salt', resetRequired: false });
  });

  it('a lost write with no row left answers stale-salt, never a 500', async () => {
    pinVerifierRepo.findOne
      .mockResolvedValueOnce({ id: 'p', userId: 'u1', verifier: '', salt: 's' })
      .mockResolvedValueOnce(null);
    pinVerifierRepo.update.mockResolvedValue({ affected: 0 });

    await expect(
      controller.checkPinVerifier(
        { userId: 'u1', verifier: 'a'.repeat(64), salt: 's', intent: 'create' },
        'u1'
      )
    ).resolves.toEqual({ status: 'stale-salt', resetRequired: false });
  });

  it('a creation that lost the race is COMPARED with the winner, never told registered', async () => {
    pinVerifierRepo.findOne
      .mockResolvedValueOnce({ id: 'p', userId: 'u1', verifier: '', salt: 's' })
      .mockResolvedValueOnce({ id: 'p', userId: 'u1', verifier: 'b'.repeat(64), salt: 's' });
    pinVerifierRepo.update.mockResolvedValue({ affected: 0 });

    const lost = await controller.checkPinVerifier(
      { userId: 'u1', verifier: 'a'.repeat(64), salt: 's', intent: 'create' },
      'u1'
    );
    expect(lost).toEqual({ status: 'mismatch', resetRequired: false });
  });

  it('the same PIN chosen on both devices: the loser is told ok', async () => {
    pinVerifierRepo.findOne
      .mockResolvedValueOnce({ id: 'p', userId: 'u1', verifier: '', salt: 's' })
      .mockResolvedValueOnce({ id: 'p', userId: 'u1', verifier: 'a'.repeat(64), salt: 's' });
    pinVerifierRepo.update.mockResolvedValue({ affected: 0 });

    await expect(
      controller.checkPinVerifier(
        { userId: 'u1', verifier: 'a'.repeat(64), salt: 's', intent: 'create' },
        'u1'
      )
    ).resolves.toEqual({ status: 'ok', resetRequired: false });
  });

  it('an UNLOCK on an account with no PIN answers not-set and stores nothing', async () => {
    pinVerifierRepo.findOne.mockResolvedValue({ id: 'p', userId: 'u1', verifier: '', salt: 's' });

    const result = await controller.checkPinVerifier(
      { userId: 'u1', verifier: 'a'.repeat(64), salt: 's', intent: 'unlock' },
      'u1'
    );

    expect(result).toEqual({ status: 'not-set', resetRequired: false });
    expect(pinVerifierRepo.update).not.toHaveBeenCalled();
    expect(pinVerifierRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(pinVerifierRepo.save).not.toHaveBeenCalled();
  });

  it('refuses an intent it does not know', async () => {
    pinVerifierRepo.findOne.mockResolvedValue(null);
    await expect(
      controller.checkPinVerifier(
        { userId: 'u1', verifier: 'a'.repeat(64), intent: 'other' as 'create' },
        'u1'
      )
    ).rejects.toThrow('intent invalid');
  });

  it('LEGACY: a client sending no intent still registers (until the client floor passes)', async () => {
    pinVerifierRepo.findOne.mockResolvedValue({ id: 'p', userId: 'u1', verifier: '', salt: 's' });
    pinVerifierRepo.update.mockResolvedValue({ affected: 1 });

    await expect(
      controller.checkPinVerifier({ userId: 'u1', verifier: 'a'.repeat(64) }, 'u1')
    ).resolves.toEqual({ status: 'registered', resetRequired: false });
  });

  /** The insert builder `registerVerifier` drives; `raw` is what `ON CONFLICT DO NOTHING` returned. */
  const insertReturning = (raw: unknown[]) => {
    const builder = {
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ raw }),
    };
    pinVerifierRepo.createQueryBuilder.mockReturnValue(builder);
    return builder;
  };

  it('INSERTs a new row when there is none, and a lost insert race is compared, not a 500', async () => {
    pinVerifierRepo.findOne.mockResolvedValue(null);
    const builder = insertReturning([{ id: 'n' }]);

    await expect(
      controller.checkPinVerifier(
        { userId: 'u1', verifier: 'a'.repeat(64), intent: 'create' },
        'u1'
      )
    ).resolves.toEqual({ status: 'registered', resetRequired: false });
    expect(builder.values).toHaveBeenCalledWith({ userId: 'u1', verifier: 'a'.repeat(64) });
    expect(builder.orIgnore).toHaveBeenCalled();

    // A concurrent insert won (no row returned): its verifier is compared, nothing is filled.
    pinVerifierRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'w', userId: 'u1', verifier: 'a'.repeat(64) });
    insertReturning([]);
    await expect(
      controller.checkPinVerifier(
        { userId: 'u1', verifier: 'a'.repeat(64), intent: 'create' },
        'u1'
      )
    ).resolves.toEqual({ status: 'ok', resetRequired: false });
    expect(pinVerifierRepo.update).not.toHaveBeenCalled();

    // The conflict was a placeholder `pin-salt` minted meanwhile: its salt is not the caller's.
    pinVerifierRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'm', userId: 'u1', verifier: '', salt: 's9' });
    insertReturning([]);
    await expect(
      controller.checkPinVerifier({ userId: 'u1', verifier: 'a'.repeat(64) }, 'u1')
    ).resolves.toEqual({ status: 'stale-salt', resetRequired: false });
    expect(pinVerifierRepo.update).not.toHaveBeenCalled();
  });

  /**
   * A PIN CHOSEN BEFORE SALTS (`salt IS NULL`, a real verifier) is still a PIN. `GET pin-salt` used to
   * delete that row and mint a placeholder, and the next `unlock` was then answered `not-set`: someone
   * who had typed their PIN for months was told to choose one (review of #3909).
   */
  describe('a PIN from before salts', () => {
    const LEGACY = { id: 'l', userId: 'u1', verifier: 'c'.repeat(64), salt: null };

    it('pin-salt salts the row in place and keeps the fact that it holds a PIN', async () => {
      pinVerifierRepo.findOne.mockResolvedValue(LEGACY);
      pinVerifierRepo.update.mockResolvedValue({ affected: 1 });

      const { salt } = await controller.getPinSalt('u1', 'u1');

      expect(salt).toMatch(/^[0-9a-f]{32}$/);
      expect(pinVerifierRepo.update).toHaveBeenCalledWith(
        { id: 'l', salt: expect.anything() },
        { salt, verifier: LEGACY_UNSALTED_VERIFIER }
      );
      expect(pinVerifierRepo.save).not.toHaveBeenCalled();
    });

    it('pin-status reads the salted legacy row as registered', async () => {
      pinVerifierRepo.findOne.mockResolvedValue({ id: 'l', verifier: LEGACY_UNSALTED_VERIFIER });
      await expect(controller.getPinStatus('u1', 'u1')).resolves.toEqual({ registered: true });
    });

    it('its next UNLOCK re-registers the PIN typed - never not-set', async () => {
      pinVerifierRepo.findOne.mockResolvedValue({
        id: 'l',
        userId: 'u1',
        verifier: LEGACY_UNSALTED_VERIFIER,
        salt: 's',
      });
      pinVerifierRepo.update.mockResolvedValue({ affected: 1 });

      await expect(
        controller.checkPinVerifier(
          { userId: 'u1', verifier: 'a'.repeat(64), salt: 's', intent: 'unlock' },
          'u1'
        )
      ).resolves.toEqual({ status: 'registered', resetRequired: false });
      expect(pinVerifierRepo.update).toHaveBeenCalledWith(
        { id: 'l', verifier: LEGACY_UNSALTED_VERIFIER },
        { verifier: 'a'.repeat(64) }
      );
    });

    it('a legacy row with no PIN becomes a plain placeholder', async () => {
      pinVerifierRepo.findOne.mockResolvedValue({ ...LEGACY, verifier: '' });
      pinVerifierRepo.update.mockResolvedValue({ affected: 1 });

      const { salt } = await controller.getPinSalt('u1', 'u1');

      expect(pinVerifierRepo.update).toHaveBeenCalledWith(
        { id: 'l', salt: expect.anything() },
        { salt, verifier: '' }
      );
    });
  });

  describe('getPinSalt - one salt per account, minted idempotently', () => {
    const insertReturningRows = (raw: unknown[]) => {
      const builder = {
        insert: jest.fn().mockReturnThis(),
        values: jest.fn().mockReturnThis(),
        orIgnore: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ raw }),
      };
      pinVerifierRepo.createQueryBuilder.mockReturnValue(builder);
      return builder;
    };

    it('returns the salt a row already holds, writing nothing', async () => {
      pinVerifierRepo.findOne.mockResolvedValue({ id: 'p', verifier: '', salt: 'abc' });
      await expect(controller.getPinSalt('u1', 'u1')).resolves.toEqual({ salt: 'abc' });
      expect(pinVerifierRepo.update).not.toHaveBeenCalled();
      expect(pinVerifierRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('no row: a placeholder INSERTed ON CONFLICT DO NOTHING', async () => {
      pinVerifierRepo.findOne.mockResolvedValue(null);
      const builder = insertReturningRows([{ id: 'n' }]);

      const { salt } = await controller.getPinSalt('u1', 'u1');

      expect(builder.values).toHaveBeenCalledWith({ userId: 'u1', verifier: '', salt });
      expect(builder.orIgnore).toHaveBeenCalled();
    });

    it('a concurrent GET minted first: its salt is returned, never a 500', async () => {
      pinVerifierRepo.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'w', verifier: '', salt: 'theirs' });
      insertReturningRows([]);

      await expect(controller.getPinSalt('u1', 'u1')).resolves.toEqual({ salt: 'theirs' });
    });

    it('a row that changed again before the read back is a 409, nothing guessed', async () => {
      pinVerifierRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      insertReturningRows([]);

      await expect(controller.getPinSalt('u1', 'u1')).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('getPinStatus - registered means a NON-EMPTY verifier', () => {
    it('reads the placeholder row pin-salt writes as NOT registered', async () => {
      pinVerifierRepo.findOne.mockResolvedValue({ id: 'p', verifier: '' });
      await expect(controller.getPinStatus('u1', 'u1')).resolves.toEqual({ registered: false });
    });

    it('reads a stored verifier as registered, and no row as not', async () => {
      pinVerifierRepo.findOne.mockResolvedValue({ id: 'p', verifier: 'a'.repeat(64) });
      await expect(controller.getPinStatus('u1', 'u1')).resolves.toEqual({ registered: true });
      pinVerifierRepo.findOne.mockResolvedValue(null);
      await expect(controller.getPinStatus('u1', 'u1')).resolves.toEqual({ registered: false });
    });
  });

  /**
   * Test 3 — PIN correct (match)
   *
   * When the submitted verifier matches the stored one, the endpoint returns
   * { status: 'ok' }.
   */
  it('returns ok when the verifier matches the stored one', async () => {
    const verifier = 'a'.repeat(64);
    pinVerifierRepo.findOne.mockResolvedValue({
      id: 'existing-id',
      userId: 'u1',
      verifier,
    });

    const result = await controller.checkPinVerifier({ userId: 'u1', verifier }, 'u1');

    expect(result).toEqual({ status: 'ok', resetRequired: false });
  });

  /**
   * Test 4 — PIN incorrect (mismatch)
   *
   * When the submitted verifier differs from the stored one, the endpoint returns
   * { status: 'mismatch' }.
   */
  it('returns mismatch when the verifier differs from the stored one', async () => {
    pinVerifierRepo.findOne.mockResolvedValue({
      id: 'existing-id',
      userId: 'u1',
      verifier: 'a'.repeat(64),
    });

    const result = await controller.checkPinVerifier(
      { userId: 'u1', verifier: 'b'.repeat(64) },
      'u1'
    );

    expect(result).toEqual({ status: 'mismatch', resetRequired: false });
  });

  /**
   * The salt the client derived from, checked BEFORE anything is compared or stored.
   *
   * A keypad asks the salt while the person types; a PIN reset in that window deletes the row and the
   * next GET mints another salt. A verifier from the old salt is then neither a wrong PIN nor a
   * registration - it is a stale input, and is answered as one.
   */
  it('answers stale-salt for a salt the row no longer holds, and compares nothing', async () => {
    pinVerifierRepo.findOne.mockResolvedValue({
      id: 'existing-id',
      userId: 'u1',
      verifier: 'a'.repeat(64),
      salt: 'new-salt',
    });

    const result = await controller.checkPinVerifier(
      { userId: 'u1', verifier: 'a'.repeat(64), salt: 'old-salt' },
      'u1'
    );

    expect(result).toEqual({ status: 'stale-salt', resetRequired: false });
    expect(revokedDeviceRepo.findOne).not.toHaveBeenCalled();
    expect(pinVerifierRepo.save).not.toHaveBeenCalled();
  });

  it('answers stale-salt instead of registering when a reset deleted the row', async () => {
    pinVerifierRepo.findOne.mockResolvedValue(null);

    const result = await controller.checkPinVerifier(
      { userId: 'u1', verifier: 'a'.repeat(64), salt: 'old-salt' },
      'u1'
    );

    expect(result).toEqual({ status: 'stale-salt', resetRequired: false });
    expect(pinVerifierRepo.create).not.toHaveBeenCalled();
    expect(pinVerifierRepo.save).not.toHaveBeenCalled();
  });

  it('compares as before when the salt sent is the one the row holds', async () => {
    const verifier = 'a'.repeat(64);
    pinVerifierRepo.findOne.mockResolvedValue({
      id: 'existing-id',
      userId: 'u1',
      verifier,
      salt: 'the-salt',
    });

    const result = await controller.checkPinVerifier(
      { userId: 'u1', verifier, salt: 'the-salt' },
      'u1'
    );

    expect(result).toEqual({ status: 'ok', resetRequired: false });
  });

  describe('changePin - a compare-and-swap on the verifier', () => {
    const OLD = 'a'.repeat(64);
    const NEW = 'b'.repeat(64);
    const row = () => ({ id: 'r1', userId: 'u1', verifier: OLD, salt: 's' });

    it('rotates the verifier only where the row still holds the one compared', async () => {
      pinVerifierRepo.findOne.mockResolvedValue(row());
      pinVerifierRepo.update.mockResolvedValue({ affected: 1 });

      await expect(
        controller.changePin({ userId: 'u1', oldVerifier: OLD, newVerifier: NEW }, 'u1')
      ).resolves.toEqual({ ok: true });

      expect(pinVerifierRepo.update).toHaveBeenCalledWith(
        { userId: 'u1', verifier: OLD },
        { verifier: NEW }
      );
      expect(pinVerifierRepo.save).not.toHaveBeenCalled();
    });

    it('refuses the second of two concurrent changes: the row moved after its check', async () => {
      // Both requests read OLD; the first swapped it, so the second's conditional write matches none.
      pinVerifierRepo.findOne.mockResolvedValue(row());
      pinVerifierRepo.update.mockResolvedValue({ affected: 0 });

      await expect(
        controller.changePin({ userId: 'u1', oldVerifier: OLD, newVerifier: NEW }, 'u1')
      ).rejects.toThrow('current PIN is incorrect');
    });

    it('refuses a wrong current PIN without writing', async () => {
      pinVerifierRepo.findOne.mockResolvedValue(row());

      await expect(
        controller.changePin({ userId: 'u1', oldVerifier: NEW, newVerifier: OLD }, 'u1')
      ).rejects.toThrow('current PIN is incorrect');
      expect(pinVerifierRepo.update).not.toHaveBeenCalled();
    });
  });
});

/**
 * ROUND 9 OF THE REVIEW OF #2919: the PIN reset's commit point is the deletion of the verifier, which
 * holds the salt. A client that lost the answer compares the salt with the one it had before asking,
 * so the salt must go BEFORE anything else is done - "same salt" then proves nothing was purged.
 */
describe('SecurityController - resetPin', () => {
  let controller: SecurityController;
  const order: string[] = [];
  const purge = jest.fn();
  const verifierDelete = jest.fn();
  const revocationsDelete = jest.fn();

  beforeEach(async () => {
    order.length = 0;
    verifierDelete.mockReset();
    verifierDelete.mockImplementation(async () => order.push('delete verifier'));
    revocationsDelete.mockReset();
    revocationsDelete.mockImplementation(async () => order.push('delete revocations'));
    purge.mockReset();
    purge.mockImplementation(async (_u: string, d: string) => {
      order.push(`purge ${d}`);
    });
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SecurityController],
      providers: [
        {
          provide: getRepositoryToken(PinVerifier),
          useValue: { delete: verifierDelete },
        },
        {
          provide: getRepositoryToken(RevokedDevice),
          useValue: { delete: revocationsDelete },
        },
        {
          provide: getRepositoryToken(KeyPackage),
          useValue: {
            find: jest.fn(async () => {
              order.push('find devices');
              return [{ deviceId: 'd1' }, { deviceId: 'd2' }, { deviceId: 'd1' }];
            }),
          },
        },
        { provide: MessagingService, useValue: { purgeDeviceFootprint: purge } },
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(UserThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ClientIpThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(SecurityController);
  });

  it('deletes the verifier before it purges any device', async () => {
    await expect(controller.resetPin({ userId: 'u1' }, 'u1')).resolves.toEqual({
      ok: true,
      devicesPurged: 2,
    });
    expect(order.indexOf('delete verifier')).toBeLessThan(order.indexOf('purge d1'));
    expect(order.indexOf('delete verifier')).toBeLessThan(order.indexOf('find devices'));
  });

  // Round 11 (N2): the revocations are cleared only AFTER the verifier, never beside it.
  it('a verifier delete that fails clears no revocation - a revoked device stays revoked', async () => {
    verifierDelete.mockImplementation(async () => {
      throw new Error('db down');
    });
    await expect(controller.resetPin({ userId: 'u1' }, 'u1')).rejects.toThrow('db down');
    expect(revocationsDelete).not.toHaveBeenCalled();
    expect(purge).not.toHaveBeenCalled();
  });

  it('a revocations delete that fails after the verifier still purges, and answers 5xx', async () => {
    revocationsDelete.mockImplementation(async () => {
      order.push('delete revocations');
      throw new Error('db down');
    });
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(controller.resetPin({ userId: 'u1' }, 'u1')).rejects.toBeInstanceOf(
      InternalServerErrorException
    );
    expect(order.slice(0, 2)).toEqual(['delete verifier', 'delete revocations']);
    expect(order).toContain('purge d1');
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('stay revoked'));
    logged.mockRestore();
  });

  it('purges every device even when one fails, and answers 5xx after the commit point', async () => {
    purge.mockImplementation(async (_u: string, d: string) => {
      order.push(`purge ${d}`);
      if (d === 'd1') throw new Error('redis down');
    });
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(controller.resetPin({ userId: 'u1' }, 'u1')).rejects.toBeInstanceOf(
      InternalServerErrorException
    );
    expect(order).toContain('delete verifier');
    expect(order).toContain('purge d2');
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('device=d1'));
    logged.mockRestore();
  });
});
