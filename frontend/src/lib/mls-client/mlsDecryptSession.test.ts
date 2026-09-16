import { createSequentialDecryptSession } from './mlsDecryptSession';

describe('createSequentialDecryptSession', () => {
  it('uses batch decrypt when the service exposes processIncomingMessagesBatch', async () => {
    const processIncomingMessagesBatch = vi.fn().mockResolvedValue([
      { ok: true, plaintext: new Uint8Array([1]) },
      { ok: true, plaintext: null },
    ]);
    const processIncomingMessage = vi.fn();
    const session = createSequentialDecryptSession(
      { processIncomingMessage, processIncomingMessagesBatch },
      'g1'
    );

    const results = await session.decryptPage([new Uint8Array([10]), new Uint8Array([20])]);

    expect(results).toEqual([
      { ok: true, plaintext: new Uint8Array([1]) },
      { ok: true, plaintext: null },
    ]);
    expect(processIncomingMessagesBatch).toHaveBeenCalledWith('g1', [
      new Uint8Array([10]),
      new Uint8Array([20]),
    ]);
    expect(processIncomingMessage).not.toHaveBeenCalled();
  });

  it('maps each decrypt to an ok result preserving order, null included', async () => {
    const processIncomingMessage = vi
      .fn()
      .mockResolvedValueOnce(new Uint8Array([1]))
      .mockResolvedValueOnce(null);
    const session = createSequentialDecryptSession({ processIncomingMessage }, 'g1');

    const results = await session.decryptPage([new Uint8Array([10]), new Uint8Array([20])]);

    expect(results).toEqual([
      { ok: true, plaintext: new Uint8Array([1]) },
      { ok: true, plaintext: null },
    ]);
    expect(processIncomingMessage).toHaveBeenNthCalledWith(1, 'g1', new Uint8Array([10]));
  });

  it('captures a per-message decrypt error without aborting the page', async () => {
    const processIncomingMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error('WrongEpoch'))
      .mockResolvedValueOnce(new Uint8Array([2]));
    const session = createSequentialDecryptSession({ processIncomingMessage }, 'g1');

    const results = await session.decryptPage([new Uint8Array([1]), new Uint8Array([2])]);

    // `Error: ` is expected on purpose: the row carries `String(e)`, so the TYPE of what was
    // thrown crosses the boundary with its sentence rather than being discarded at the throw.
    expect(results[0]).toEqual({ ok: false, error: 'Error: WrongEpoch' });
    expect(results[1]).toEqual({ ok: true, plaintext: new Uint8Array([2]) });
  });

  it('finish is a no-op (live client already advanced)', async () => {
    const session = createSequentialDecryptSession({ processIncomingMessage: vi.fn() }, 'g1');
    await expect(session.finish()).resolves.toBeUndefined();
  });
});
