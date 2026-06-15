import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installMlsStatePersisterLifecycle,
  uninstallMlsStatePersisterLifecycle,
} from './mlsStatePersisterLifecycle';
import type { MlsStatePersister } from './mlsStatePersister';

function makePersister(): MlsStatePersister {
  return {
    persistNow: vi.fn(),
    scheduleDeferred: vi.fn(),
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
    expect(document.addEventListener).toHaveBeenCalledTimes(1);
    expect(window.addEventListener).toHaveBeenCalledTimes(1);
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
  });
});
