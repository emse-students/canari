/// <reference types="jest" />

/**
 * `DELETE media/internal/users/:userId` is called by core-service's durable erasure queue, which
 * retries until the answer is 2xx. So the status IS the contract: a 2xx while some object could not
 * be deleted would close the job with that object still stored, for ever.
 */
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { MediaController } from './media.controller';
import type { MediaService } from './media.service';

const SECRET = 'erasure-secret';

function build(result: { deleted: number; failed: number }, order: string[] = []) {
  return buildWith(result, order).controller;
}

function buildWith(result: { deleted: number; failed: number }, order: string[] = []) {
  const svc = {
    removeAllOwnedBy: jest.fn(async () => {
      order.push('media');
      return result;
    }),
  };
  const sessions = {
    cancelAllOwnedBy: jest.fn(async (id: string) => {
      order.push(`sessions:${id}`);
      return 1;
    }),
  };
  const controller = new MediaController(
    svc as unknown as MediaService,
    sessions as never,
    {} as never
  );
  return { controller, svc, sessions };
}

const prev = process.env.INTERNAL_SECRET;
beforeAll(() => {
  process.env.INTERNAL_SECRET = SECRET;
});
afterAll(() => {
  if (prev === undefined) delete process.env.INTERNAL_SECRET;
  else process.env.INTERNAL_SECRET = prev;
});

describe('DELETE media/internal/users/:userId', () => {
  it('answers ok when every owned object is gone', async () => {
    await expect(build({ deleted: 3, failed: 0 }).removeAllOwnedBy('u1', SECRET)).resolves.toEqual({
      ok: true,
      deleted: 3,
      failed: 0,
    });
  });

  it('answers 503 while any object failed, so the queue retries instead of closing the job', async () => {
    await expect(
      build({ deleted: 2, failed: 1 }).removeAllOwnedBy('u1', SECRET)
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('erases the objects FIRST - that call records the erasure, so no session can register or open after it - then ends the sessions', async () => {
    const order: string[] = [];
    await build({ deleted: 0, failed: 0 }, order).removeAllOwnedBy('u1', SECRET);
    expect(order).toEqual(['media', 'sessions:u1']);
  });

  it.each([[''], ['a b'], ['a:b'], ['caf\u00e9'], ['tab\there']])(
    'refuses an id no account could carry (%j) with 400 USER_ID_INVALID, recording nothing',
    async (id) => {
      const { controller, svc, sessions } = buildWith({ deleted: 0, failed: 0 });
      const refused = controller.removeAllOwnedBy(id, SECRET);
      await expect(refused).rejects.toBeInstanceOf(BadRequestException);
      await expect(refused).rejects.toMatchObject({ response: { code: 'USER_ID_INVALID' } });
      expect(svc.removeAllOwnedBy).not.toHaveBeenCalled();
      expect(sessions.cancelAllOwnedBy).not.toHaveBeenCalled();
    }
  );

  it('ends the sessions even when an object failed, and still answers 503', async () => {
    const order: string[] = [];
    await expect(
      build({ deleted: 0, failed: 1 }, order).removeAllOwnedBy('u1', SECRET)
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(order).toEqual(['media', 'sessions:u1']);
  });
});
