// @vitest-environment happy-dom
import {
  installMlsStatePersisterLifecycle,
  uninstallMlsStatePersisterLifecycle,
} from './mlsStatePersisterLifecycle';
import type { MlsStatePersister } from './mlsStatePersister';
import { APP_FOREGROUND_EVENT } from '$lib/utils/appForeground';

function makePersister(): MlsStatePersister {
  return {
    persistNow: vi.fn(),
    scheduleDeferred: vi.fn(),
    noteReceivedFrame: vi.fn(),
    markStructural: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    flushEncrypted: vi.fn().mockResolvedValue(undefined),
    onBulkIngestStart: vi.fn(),
    onBulkIngestEnd: vi.fn().mockResolvedValue(undefined),
  };
}

describe('mlsStatePersisterLifecycle', () => {
  beforeEach(() => {
    uninstallMlsStatePersisterLifecycle();
    vi.spyOn(document, 'addEventListener');
    vi.spyOn(document, 'removeEventListener');
    vi.spyOn(window, 'addEventListener');
    vi.spyOn(window, 'removeEventListener');
  });

  afterEach(() => {
    uninstallMlsStatePersisterLifecycle();
    vi.restoreAllMocks();
  });

  it('installs visibilitychange and pagehide listeners once', () => {
    const persister = makePersister();
    installMlsStatePersisterLifecycle(persister);
    installMlsStatePersisterLifecycle(persister);

    expect(document.addEventListener).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function),
      { passive: true }
    );
    expect(window.addEventListener).toHaveBeenCalledWith('pagehide', expect.any(Function), {
      capture: true,
    });
    expect(window.addEventListener).toHaveBeenCalledWith(
      APP_FOREGROUND_EVENT,
      expect.any(Function)
    );
    expect(document.addEventListener).toHaveBeenCalledTimes(1);
    // pagehide + the native foreground edge, each once despite the second install.
    expect(window.addEventListener).toHaveBeenCalledTimes(2);
  });

  it('flushes encrypted state when the document becomes hidden', () => {
    const persister = makePersister();
    installMlsStatePersisterLifecycle(persister);

    const visibilityCall = vi
      .mocked(document.addEventListener)
      .mock.calls.find(([type]) => type === 'visibilitychange');
    const handler = visibilityCall?.[1] as () => void;

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    handler();

    expect(persister.flushEncrypted).toHaveBeenCalledTimes(1);
  });

  it('uninstall removes lifecycle listeners', () => {
    const persister = makePersister();
    installMlsStatePersisterLifecycle(persister);
    uninstallMlsStatePersisterLifecycle();

    expect(document.removeEventListener).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function)
    );
    expect(window.removeEventListener).toHaveBeenCalledWith('pagehide', expect.any(Function), {
      capture: true,
    });
    expect(window.removeEventListener).toHaveBeenCalledWith(
      APP_FOREGROUND_EVENT,
      expect.any(Function)
    );
  });

  // A backgrounded Android WebView stays `visible`, so the native edge is the only trigger there.
  it('flushes encrypted state when the NATIVE app goes to the background, and not when it returns', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const persister = makePersister();
    installMlsStatePersisterLifecycle(persister);

    window.dispatchEvent(new CustomEvent(APP_FOREGROUND_EVENT, { detail: { foreground: true } }));
    expect(persister.flushEncrypted).not.toHaveBeenCalled();

    window.dispatchEvent(new CustomEvent(APP_FOREGROUND_EVENT, { detail: { foreground: false } }));
    expect(persister.flushEncrypted).toHaveBeenCalledTimes(1);

    uninstallMlsStatePersisterLifecycle();
    window.dispatchEvent(new CustomEvent(APP_FOREGROUND_EVENT, { detail: { foreground: false } }));
    expect(persister.flushEncrypted).toHaveBeenCalledTimes(1);
  });

  // A sign-out removes its hooks after its final flush; by then the next session may have
  // installed its own, and those must survive the late removal.
  it("a late uninstall of the previous session's persister leaves the next session's hooks", () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const previous = makePersister();
    const next = makePersister();
    installMlsStatePersisterLifecycle(previous);
    installMlsStatePersisterLifecycle(next);

    uninstallMlsStatePersisterLifecycle(previous);
    window.dispatchEvent(new CustomEvent(APP_FOREGROUND_EVENT, { detail: { foreground: false } }));

    expect(next.flushEncrypted).toHaveBeenCalledTimes(1);
    // Replaced, not doubled: the previous session's hooks went when the next ones arrived.
    expect(previous.flushEncrypted).not.toHaveBeenCalled();
  });
});
