/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { MessagingController } from './messaging.controller';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { MessagingService, SendMessageBody } from '../services/messaging.service';

/**
 * `POST /mls/send` accepts the fields a client sends and nothing else (`assertClientSendFields`).
 *
 * Who receives a frame and whether it is a handshake are decided by the server: the recipient set
 * from the membership table, a commit by `POST /mls/commit`. The fields that would let a caller
 * decide either are set by the service's own callers only, which never cross this route.
 */
describe('MessagingController - POST mls/send accepts client fields only', () => {
  let controller: MessagingController;
  let warn: jest.SpyInstance;
  const sendMessage = jest.fn().mockResolvedValue({ status: 'ok', queued: 1, sent: 1 });

  const clientBody = (extra: Record<string, unknown> = {}): SendMessageBody =>
    ({
      senderId: 'alice',
      senderDeviceId: 'web-a',
      groupId: 'g1',
      proto: 'cGF5bG9hZA==',
      silent: false,
      durable: true,
      ...extra,
    }) as SendMessageBody;

  beforeEach(async () => {
    sendMessage.mockClear();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MessagingController],
      providers: [
        { provide: MessagingService, useValue: { sendMessage } as unknown as MessagingService },
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(MessagingController);
  });

  afterEach(() => warn.mockRestore());

  it('passes the body the web client sends, addressed or not', async () => {
    await controller.sendMessage(clientBody(), 'alice');
    await controller.sendMessage(clientBody({ recipientDevices: ['bob:web-b'] }), 'alice');

    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['excludeDeviceIds', { excludeDeviceIds: ['bob:web-b'] }],
    ['isCommit', { isCommit: true }],
    ['isWelcome', { isWelcome: true }],
    ['recipients', { recipients: [{ userId: 'bob', deviceId: 'web-b' }] }],
    ['an unknown field', { somethingNew: 1 }],
  ])('refuses %s, and reaches no delivery', async (_name, extra) => {
    await expect(controller.sendMessage(clientBody(extra), 'alice')).rejects.toThrow(
      'not accepted on a client send'
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('names the refused field and the caller in one line', async () => {
    await expect(
      controller.sendMessage(clientBody({ excludeDeviceIds: ['bob:web-b'] }), 'alice')
    ).rejects.toThrow('excludeDeviceIds');

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('REJECT client_fields');
    expect(line).toContain('user=alice');
    expect(line).toContain('device=web-a');
  });

  it('refuses a body that is not an object', async () => {
    await expect(controller.sendMessage([] as unknown as SendMessageBody, 'alice')).rejects.toThrow(
      'must be an object'
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
