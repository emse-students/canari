// Stub Tauri internals before any import: the CJS `@tauri-apps/api/core` reads this global.
const tauriInvokeStub = vi.fn((cmd: string) => {
  if (cmd === 'get_fcm_token') return Promise.resolve('tok-perm');
  return Promise.resolve(undefined);
});

Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {
  value: { invoke: tauriInvokeStub, transformCallback: vi.fn() },
  writable: true,
  configurable: true,
});

const { osPlatformStub } = vi.hoisted(() => ({ osPlatformStub: vi.fn(() => 'android') }));
vi.mock('@tauri-apps/plugin-os', () => ({ platform: osPlatformStub }));

const { isPermissionGranted, requestPermission } = vi.hoisted(() => ({
  isPermissionGranted: vi.fn(async () => false),
  requestPermission: vi.fn(async () => 'granted' as const),
}));
vi.mock('@tauri-apps/plugin-notification', () => ({ isPermissionGranted, requestPermission }));

vi.mock('$lib/stores/user', () => ({ currentUserId: vi.fn(() => 'user-1') }));
vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: vi.fn(() => true) }));

/**
 * Per-case budget, and it is about IMPORTS, not about the app.
 *
 * Every case calls `vi.resetModules` so it gets a service whose `pushAttempted` is false - a real
 * first launch rather than the foreground-return fast path - and that means re-importing this
 * module graph each time. The first import alone outran the 5 s default, which reads as a hung test
 * and is nothing of the kind.
 */
const IMPORT_BUDGET_MS = 30_000;

type ConfirmModule = typeof import('$lib/stores/confirm.svelte');
type ServiceModule = typeof import('./PushNotificationService');

/**
 * THE RATIONALE IS ACKNOWLEDGED, NEVER TIMED.
 *
 * Android's own permission dialog takes every touch until it is answered, which is correct for a
 * native dialog and is exactly why nothing else may be asking at the same moment. The app used to
 * show a 6 s toast carrying the rationale and open the OS dialog 1200 ms into it, so for the
 * remaining 4,8 s both were on screen - measured on A1 on 2026-09-14, on the first launch after an
 * install, where it presented as an app that had stopped repainting while still answering CDP.
 *
 * A sleep cannot be right here whatever its length: it is a guess about how fast someone reads, and
 * the thing it races is a dialog this code opens itself. The two are sequenced by the one event
 * that PROVES the first is finished - the user dismissing it.
 *
 * The real store is used rather than a stand-in, because the property under test is that the
 * service awaits something only a user gesture settles; a mock resolving on its own would assert
 * the mock.
 */
describe('startPushService and the notification permission rationale', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    sessionStorage.clear();
    osPlatformStub.mockReturnValue('android');
    isPermissionGranted.mockResolvedValue(false);
    requestPermission.mockResolvedValue('granted');
    tauriInvokeStub.mockImplementation((cmd: string) => {
      if (cmd === 'get_fcm_token') return Promise.resolve('tok-perm');
      return Promise.resolve(undefined);
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pushSecret: 'secret' }),
      text: async () => '',
    });
  });

  /**
   * Loads the service AND the confirm store from the same module graph.
   *
   * `vi.resetModules` above means a fresh `pushAttempted`, so each case really is a first launch
   * rather than the foreground-return fast path - but it also means a fresh confirm store, and a
   * copy imported at the top of this file would be a DIFFERENT instance from the one the service
   * writes to. Both are taken here, after the reset, so the test drives the dialog the service
   * actually opened.
   */
  async function loadService(): Promise<ServiceModule & ConfirmModule> {
    const [service, confirm] = await Promise.all([
      import('./PushNotificationService'),
      import('$lib/stores/confirm.svelte'),
    ]);
    return { ...service, ...confirm };
  }

  /** Resolves once the service has raised its rationale dialog, or fails the test if it never does. */
  async function waitForRationale(confirm: ConfirmModule): Promise<void> {
    for (let i = 0; i < 50; i++) {
      if (confirm.confirmStore.pending) return;
      await Promise.resolve();
    }
    throw new Error('the rationale dialog was never opened');
  }

  it(
    'does not open the OS dialog until the rationale has been answered, and schedules no timer that could',
    async () => {
      // WHAT THE OLD SHAPE DID IS EXACTLY THIS CALL: `setTimeout(r, 1200)` between the rationale and
      // the OS dialog. Recording the schedule is a stronger statement than advancing a fake clock and
      // a cheaper one: it asserts that no clock EXISTS on this path, rather than that one particular
      // clock did not fire.
      const scheduled: number[] = [];
      const realSetTimeout = globalThis.setTimeout;
      const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
        ...args: Parameters<typeof setTimeout>
      ) => {
        scheduled.push(Number(args[1] ?? 0));
        // `.apply` with the global receiver: happy-dom's `setTimeout` is a window method and
        // refuses a bare call, which hangs the poll it was meant to observe.
        return Reflect.apply(realSetTimeout, globalThis, args);
      }) as unknown as typeof setTimeout);

      const { startPushService, confirmStore, resolveConfirm } = await loadService();
      const running = startPushService('https://api', 'jwt', 'dev-perm');
      try {
        console.log('DBG rationale open');
        await waitForRationale({ confirmStore, resolveConfirm } as ConfirmModule);
        console.log('DBG rationale reached');

        // Every microtask this process can run, and the native dialog is still not open.
        for (let i = 0; i < 100; i++) await Promise.resolve();

        expect(requestPermission).not.toHaveBeenCalled();
        expect(confirmStore.pending).not.toBeNull();
        expect(scheduled, 'a timer was armed between the rationale and the OS dialog').toEqual([]);

        resolveConfirm(true);
        await running;

        expect(requestPermission).toHaveBeenCalledTimes(1);
      } finally {
        // A case that failed above must not leave the service half-run: its continuation would land
        // inside the NEXT test and be counted there, which is exactly how this file first lied.
        spy.mockRestore();
        if (confirmStore.pending) resolveConfirm(false);
        await running.catch(() => {});
      }
    },
    IMPORT_BUDGET_MS
  );

  it(
    'never spends the OS prompt on a user who answered "later"',
    async () => {
      const { startPushService, confirmStore, resolveConfirm } = await loadService();
      const running = startPushService('https://api', 'jwt', 'dev-perm');

      await waitForRationale({ confirmStore, resolveConfirm } as ConfirmModule);
      resolveConfirm(false);
      await running;

      // Android gives an app very few chances to ask. Spending one on someone who just declined the
      // explanation wastes it for good, so the refusal is honoured rather than overridden.
      expect(requestPermission).not.toHaveBeenCalled();
      // And registration continues regardless: FCM still delivers silent data messages, which is what
      // keeps the conversation list in sync even with pop-ups blocked.
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    },
    IMPORT_BUDGET_MS
  );

  it(
    'asks nobody anything when the permission is already granted',
    async () => {
      isPermissionGranted.mockResolvedValue(true);
      const { startPushService, confirmStore } = await loadService();

      await startPushService('https://api', 'jwt', 'dev-perm');

      expect(confirmStore.pending).toBeNull();
      expect(requestPermission).not.toHaveBeenCalled();
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    },
    IMPORT_BUDGET_MS
  );
});
