/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, Logger } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { MessagingController } from './messaging.controller';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { UserThrottlerGuard } from '../guards/user-throttler.guard';
import { MessagingService } from '../services/messaging.service';

/**
 * `POST /mls/integrity-finding` - a client saying it saw one of two things it must never see: a
 * conversation split in two at one epoch (`fork`), or restored history carrying a forged author
 * signature (`forged-history`). Protocol: history-reconciliation, "Restored history carries its
 * author's signature", and mls-protocol, "Fork detection".
 *
 * Judged on what is ESTABLISHED (the authenticated reporter, a member of the group) against what is
 * only CLAIMED (the peer it names), and on no forged line.
 */
describe('MessagingController - POST mls/integrity-finding', () => {
  let controller: MessagingController;
  let error: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let members: Set<string>;

  beforeEach(async () => {
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    members = new Set(['g-1234|alice', 'g-1\n[SEND] forged|alice']);
    const service = {
      isGroupMember: async (groupId: string, userId: string) => members.has(`${groupId}|${userId}`),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MessagingController],
      providers: [{ provide: MessagingService, useValue: service as unknown as MessagingService }],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(UserThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(MessagingController);
  });

  afterEach(() => {
    error.mockRestore();
    warn.mockRestore();
  });

  it('prints a fork with its epoch, the reporter as a fact and the peer as a claim', async () => {
    await expect(
      controller.reportIntegrityFinding('alice', 'web-alice-1', {
        kind: 'fork',
        groupId: 'g-1234',
        epoch: 7,
        peer: 'bob:dev-b',
        detail: 'fork',
        proven: true,
      })
    ).resolves.toEqual({ recorded: true });

    expect(error).toHaveBeenCalledWith(
      '[INTEGRITY] kind=fork reporter=alice:web-alice-1 group=g-1234 epoch=7 claimedPeer=bob:dev-b proven=true detail=fork'
    );
  });

  it('prints no full user id - the reporter and the peer, each device kept apart', async () => {
    const alice = 'a1'.repeat(32);
    const bob = 'b2'.repeat(32);
    members.add(`g-1234|${alice}`);

    await controller.reportIntegrityFinding(alice, `web-${alice}-mh9x2k1q-a7c3`, {
      kind: 'fork',
      groupId: 'g-1234',
      epoch: 7,
      peer: `${bob}:tauri-${bob}-mh9x2k1q-0z9y`,
      detail: 'fork',
      proven: true,
    });

    const line = error.mock.calls[0][0] as string;
    expect(line).not.toContain(alice);
    expect(line).not.toContain(bob);
    expect(line).toContain(
      'reporter=a1a1a1a1:web-a1a1a1a1-mh9x2k1q-a7c3 group=g-1234 epoch=7 ' +
        'claimedPeer=b2b2b2b2:tauri-b2b2b2b2-mh9x2k1q-0z9y'
    );
  });

  it('prints an unproven fork at warn, as mls-core does', async () => {
    await controller.reportIntegrityFinding('alice', 'web-alice-1', {
      kind: 'fork',
      groupId: 'g-1234',
      epoch: 7,
      peer: 'bob:dev-b',
      detail: 'unproven',
      proven: false,
    });
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('proven=false detail=unproven'));
  });

  it('takes the level from the typed `proven` field, never from the free-text detail', async () => {
    await controller.reportIntegrityFinding('alice', 'web-alice-1', {
      kind: 'forged-history',
      groupId: 'g-1234',
      peer: 'mallory',
      detail: 'unproven',
      proven: true,
    });
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('proven=true detail=unproven'));
  });

  it('prints a report with no valid `proven` at ERROR, and says it is invalid', async () => {
    await controller.reportIntegrityFinding('alice', 'web-alice-1', {
      kind: 'fork',
      groupId: 'g-1234',
      epoch: 7,
      peer: 'bob:dev-b',
      detail: 'fork',
      proven: 'no',
    });
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('proven=invalid'));
  });

  it('refuses a reporter that is not a member of the group', async () => {
    await expect(
      controller.reportIntegrityFinding('mallory', 'dev-m', {
        kind: 'forged-history',
        groupId: 'g-1234',
        peer: 'alice',
        detail: 'message',
      })
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('REJECT not-a-member'));
  });

  it('prints forged history with the relayer it claims', async () => {
    await controller.reportIntegrityFinding('alice', 'web-alice-1', {
      kind: 'forged-history',
      groupId: 'g-1234',
      peer: 'mallory',
      detail: 'signature',
      proven: true,
    });
    expect(error).toHaveBeenCalledWith(
      '[INTEGRITY] kind=forged-history reporter=alice:web-alice-1 group=g-1234 epoch=none claimedPeer=mallory proven=true detail=signature'
    );
  });

  it('refuses a kind it does not know, and cannot be made to forge a line', async () => {
    await controller.reportIntegrityFinding('alice', 'web-alice-1', {
      kind: 'something\n[SEND] forged',
      groupId: 'g-1\n[SEND] forged',
      epoch: 'seven',
      peer: { not: 'a string' },
    });
    const line = error.mock.calls[0][0] as string;
    expect(line).not.toContain('\n');
    expect(line).toContain('kind=invalid');
    expect(line).toContain('group=invalid');
    expect(line).toContain('epoch=invalid');
    expect(line).toContain('claimedPeer=invalid');
  });
});
