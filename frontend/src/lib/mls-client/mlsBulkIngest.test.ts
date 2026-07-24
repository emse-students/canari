import { withMlsBulkIngest } from './mlsBulkIngest';

describe('withMlsBulkIngest', () => {
  function makeService() {
    const calls: string[] = [];
    return {
      calls,
      beginBulkIngest: vi.fn(() => calls.push('begin')),
      endBulkIngest: vi.fn(async () => {
        calls.push('end');
      }),
    };
  }

  it('opens before and closes after fn, returning its value', async () => {
    const svc = makeService();
    const result = await withMlsBulkIngest(svc, async () => {
      svc.calls.push('fn');
      return 42;
    });
    expect(result).toBe(42);
    expect(svc.calls).toEqual(['begin', 'fn', 'end']);
  });

  it('closes the window even when fn throws, and re-throws', async () => {
    const svc = makeService();
    await expect(
      withMlsBulkIngest(svc, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(svc.beginBulkIngest).toHaveBeenCalledTimes(1);
    expect(svc.endBulkIngest).toHaveBeenCalledTimes(1);
  });

  it('awaits endBulkIngest before resolving (flush completes first)', async () => {
    const svc = makeService();
    let endResolved = false;
    svc.endBulkIngest.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      endResolved = true;
    });
    await withMlsBulkIngest(svc, async () => undefined);
    expect(endResolved).toBe(true);
  });
});
