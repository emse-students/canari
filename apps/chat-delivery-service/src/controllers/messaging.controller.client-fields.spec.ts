/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { MessagingController } from './messaging.controller';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { UserThrottlerGuard } from '../guards/user-throttler.guard';
import { MessagingService, SendMessageBody } from '../services/messaging.service';
import { externalCommitFrame, mlsFrame } from '../testing/mlsFrameFixture';

/**
 * `POST /mls/send` accepts what a client sends and nothing else (`clientSendRefusal`): the allowlisted
 * fields, a `proto`, and the caller as the sender with a device.
 *
 * Who receives a frame and whether it is a handshake are decided by the server: the recipient set
 * from the membership table, a commit by `POST /mls/commit`.
 */
describe('MessagingController - POST mls/send accepts a client send only', () => {
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

  /** The refusal a call raised, for its type and its response body. */
  const refusalOf = async (body: SendMessageBody, caller = 'alice') =>
    controller.sendMessage(body, caller).catch((e: unknown) => e);

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
      .overrideGuard(UserThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(MessagingController);
  });

  afterEach(() => warn.mockRestore());

  it('passes the body the web client sends, addressed or not, whatever the case of the sender', async () => {
    await controller.sendMessage(clientBody(), 'alice');
    await controller.sendMessage(clientBody({ recipientDevices: ['bob:web-b'] }), 'alice');
    await controller.sendMessage(clientBody({ senderId: 'Alice' }), 'alice');

    expect(sendMessage).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['excludeDeviceIds', { excludeDeviceIds: ['bob:web-b'] }],
    ['isCommit', { isCommit: true }],
    ['isWelcome', { isWelcome: true }],
    ['recipients', { recipients: [{ userId: 'bob', deviceId: 'web-b' }] }],
    ['the retired content', { content: 'hi', type: 'message' }],
    ['an unknown field', { somethingNew: 1 }],
  ])('refuses %s with a generic 400, and reaches no delivery', async (_name, extra) => {
    const refusal = await refusalOf(clientBody(extra));

    expect(refusal).toBeInstanceOf(BadRequestException);
    expect((refusal as BadRequestException).getResponse()).toEqual({
      error: 'send_field_refused',
      message: 'this send is not accepted',
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('refuses a send with no proto - the content path is retired', async () => {
    const refusal = await refusalOf(clientBody({ proto: undefined }));

    expect((refusal as BadRequestException).getResponse()).toMatchObject({
      error: 'proto_required',
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  /**
   * The send route relays only private (application) frames; a public handshake frame goes through
   * the commit route, whose gate reads it. Every client seals with `create_message` under openmls's
   * default ciphertext policy, so no legitimate send is a `PublicMessage`.
   */
  it('refuses a public handshake frame with a typed 400 and an ERROR line, and relays a private one', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    try {
      const refusal = await refusalOf(
        clientBody({ proto: externalCommitFrame('g1', 5n, 'alice:web-a') })
      );

      expect(refusal).toBeInstanceOf(BadRequestException);
      expect((refusal as BadRequestException).getResponse()).toEqual({
        error: 'public_frame_refused',
        message: 'this send is not accepted',
      });
      expect(error).toHaveBeenCalledWith(expect.stringContaining('REJECT public_frame_refused'));
      expect(sendMessage).not.toHaveBeenCalled();

      await controller.sendMessage(clientBody({ proto: mlsFrame(2, 'g1', 5n) }), 'alice');
      expect(sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });

  it.each([
    ['another user', { senderId: 'bob' }],
    ['an omitted sender', { senderId: undefined }],
    ['an omitted device', { senderDeviceId: undefined }],
  ])('refuses %s as the sender with a 403', async (_name, extra) => {
    const refusal = await refusalOf(clientBody(extra));

    expect(refusal).toBeInstanceOf(ForbiddenException);
    expect((refusal as ForbiddenException).getResponse()).toMatchObject({
      error: 'sender_mismatch',
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('logs ONE line naming the caller, with every refused name sanitised and bounded', async () => {
    const forged = 'x\n[Nest] 1 - LOG forged line';
    await refusalOf(clientBody({ [forged]: 1, ['y'.repeat(500)]: 2 }));

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('REJECT send_field_refused user=alice');
    expect(line).not.toContain('\n');
    expect(line).not.toContain('forged line');
    expect(line).toContain('invalid');
    expect(line.length).toBeLessThan(400);
  });

  it('never echoes a refused name in the response body', async () => {
    const refusal = await refusalOf(clientBody({ secretField: 1 }));

    expect(JSON.stringify((refusal as BadRequestException).getResponse())).not.toContain(
      'secretField'
    );
  });

  it('refuses a body that is not an object', async () => {
    const refusal = await refusalOf([] as unknown as SendMessageBody);

    expect((refusal as BadRequestException).getResponse()).toMatchObject({
      error: 'send_body_invalid',
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
