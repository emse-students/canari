/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ThrottlerGuard } from '@nestjs/throttler';
import { SecurityController } from './security.controller';
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
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(SecurityController);
  });

  /**
   * Test 1 — Placeholder → UPDATE (the bug fix)
   *
   * When pin-salt created a placeholder row (verifier: ''), pin-check must UPDATE
   * the existing entity rather than INSERTing a second row (which would violate
   * the UNIQUE constraint on userId).
   */
  it('UPDATEs existing placeholder row (created by pin-salt) instead of INSERTing', async () => {
    const existingDoc = { id: 'existing-id', userId: 'u1', verifier: '', salt: 'abc123' };
    pinVerifierRepo.findOne.mockResolvedValue(existingDoc);
    pinVerifierRepo.save.mockResolvedValue(existingDoc);

    const result = await controller.checkPinVerifier(
      { userId: 'u1', verifier: 'a'.repeat(64) },
      'u1',
      'false'
    );

    // Must NOT call create — we're updating, not inserting
    expect(pinVerifierRepo.create).not.toHaveBeenCalled();
    // Must call save on the existing entity (with its original id)
    expect(pinVerifierRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'existing-id', userId: 'u1', verifier: 'a'.repeat(64) })
    );
    expect(result).toEqual({ status: 'registered', resetRequired: false });
  });

  /**
   * Test 2 — First registration → INSERT
   *
   * When no row exists for the user, a brand-new PinVerifier entity is created
   * and saved.
   */
  it('INSERTs a new row on first registration (no existing row)', async () => {
    pinVerifierRepo.findOne.mockResolvedValue(null);
    const newDoc = { userId: 'u1', verifier: 'a'.repeat(64) };
    pinVerifierRepo.create.mockReturnValue(newDoc);
    pinVerifierRepo.save.mockResolvedValue(newDoc);

    const result = await controller.checkPinVerifier(
      { userId: 'u1', verifier: 'a'.repeat(64) },
      'u1',
      'false'
    );

    expect(pinVerifierRepo.create).toHaveBeenCalledWith({
      userId: 'u1',
      verifier: 'a'.repeat(64),
    });
    expect(pinVerifierRepo.save).toHaveBeenCalledWith(newDoc);
    expect(result).toEqual({ status: 'registered', resetRequired: false });
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

    const result = await controller.checkPinVerifier({ userId: 'u1', verifier }, 'u1', 'false');

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
      'u1',
      'false'
    );

    expect(result).toEqual({ status: 'mismatch', resetRequired: false });
  });
});
