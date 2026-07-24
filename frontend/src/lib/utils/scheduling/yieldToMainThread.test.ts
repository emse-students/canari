import { yieldToMainThread } from './yieldToMainThread';

describe('yieldToMainThread', () => {
  it('resolves after scheduling a frame', async () => {
    const raf = vi.fn((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal('requestAnimationFrame', raf);

    await yieldToMainThread();

    expect(raf).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});
