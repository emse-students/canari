import 'reflect-metadata';

import { NotFoundException } from '@nestjs/common';

import { FormsService } from './forms.service';

/**
 * `summaries` asks `get` and `hasSubmission` - the rules are theirs - and only decides what is OMITTED.
 * A form the reader may not read is absent, as `get`'s 404 is; any other failure is not swallowed.
 */
describe('FormsService.summaries', () => {
  const viewer = { userId: 'u1', isGlobalAdmin: false };

  function service(get: jest.Mock, has: jest.Mock): FormsService {
    const svc = Object.create(FormsService.prototype) as FormsService;
    Object.assign(svc, {
      get,
      hasSubmission: has,
      logger: { debug: jest.fn() },
    });
    return svc;
  }

  it('serves title, opening date and answered state, each form once', async () => {
    const get = jest.fn(async (id: string) => ({ id, title: `t-${id}`, opensAt: null }));
    const has = jest.fn(async (id: string) => ({ hasSubmitted: id === 'a' }));
    const out = await service(get, has).summaries(['a', 'b', 'a'], viewer);
    expect(out).toEqual([
      { id: 'a', title: 't-a', opensAt: null, hasSubmitted: true },
      { id: 'b', title: 't-b', opensAt: null, hasSubmitted: false },
    ]);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('omits a form the reader may not read, and rethrows anything else', async () => {
    const get = jest.fn(async (id: string) => {
      if (id === 'gone') throw new NotFoundException();
      return { id, title: 't', opensAt: null };
    });
    const has = jest.fn(async () => ({ hasSubmitted: false }));
    await expect(service(get, has).summaries(['gone', 'ok'], viewer)).resolves.toHaveLength(1);

    get.mockRejectedValueOnce(new Error('db down'));
    await expect(service(get, has).summaries(['x'], viewer)).rejects.toThrow('db down');
  });
});
