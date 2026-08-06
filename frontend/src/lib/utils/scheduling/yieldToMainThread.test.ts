import { yieldToMainThread } from './yieldToMainThread';

describe('yieldToMainThread', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves after scheduling a frame', async () => {
    const raf = vi.fn((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal('requestAnimationFrame', raf);

    await yieldToMainThread();

    expect(raf).toHaveBeenCalledOnce();
  });

  // The regression this file exists for: `requestAnimationFrame` never fires in a hidden document,
  // and this helper is awaited inside the inbound MLS drain. On rAF alone a backgrounded tab stopped
  // receiving messages entirely, in silence, until it was brought back to the foreground.
  it('still resolves when requestAnimationFrame never fires (hidden tab)', async () => {
    const raf = vi.fn(() => 0);
    vi.stubGlobal('requestAnimationFrame', raf);

    await expect(yieldToMainThread()).resolves.toBeUndefined();

    expect(raf).toHaveBeenCalledOnce();
  });

  it('falls back to a timer when neither rAF nor MessageChannel exists', async () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    vi.stubGlobal('MessageChannel', undefined);

    await expect(yieldToMainThread()).resolves.toBeUndefined();
  });

  it('resolves once even though both the frame and the fallback fire', async () => {
    const raf = vi.fn((cb: FrameRequestCallback) => {
      setTimeout(() => cb(0), 0);
      return 0;
    });
    vi.stubGlobal('requestAnimationFrame', raf);

    // Two settles racing must not reject or double-resolve; awaiting twice would hang on a broken
    // implementation, so the assertion is that this returns at all.
    await yieldToMainThread();
    await yieldToMainThread();

    expect(raf).toHaveBeenCalledTimes(2);
  });
});
