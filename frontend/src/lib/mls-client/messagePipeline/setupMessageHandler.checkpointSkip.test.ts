// @vitest-environment happy-dom
/**
 * THE SERVER'S CHECKPOINT-SKIP MODE REALLY REACHES THE PERSISTER `setupMessageHandler` BUILDS.
 *
 * The persister's own tests inject a budget; this one drives the persister the pipeline actually
 * wires, with only the server's mode and the platform faked, so it fails if the wiring is hard-coded
 * to either answer: mode `off` checkpoints every drain, mode `on` on a phone defers, and mode `on`
 * off native mobile still checkpoints.
 */
import type { MlsStatePersister } from '../mlsStatePersister';

const fake = vi.hoisted(() => ({
  mode: 'off' as 'off' | 'on',
  nativeMobile: true,
  persisters: [] as MlsStatePersister[],
}));

vi.mock('$lib/stores/appVersionCheck.svelte', () => ({
  serverCheckpointSkipMode: () => fake.mode,
}));

vi.mock('$lib/utils/appVersion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/appVersion')>()),
  isMobileTauriRuntime: () => fake.nativeMobile,
}));

vi.mock('../mlsStatePersister', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../mlsStatePersister')>();
  return {
    ...actual,
    createMlsStatePersister: (config: Parameters<typeof actual.createMlsStatePersister>[0]) => {
      const persister = actual.createMlsStatePersister(config);
      fake.persisters.push(persister);
      return persister;
    },
  };
});

vi.mock('$lib/utils/hex', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/hex')>()),
  saveMlsState: vi.fn().mockResolvedValue(undefined),
  saveMlsStateEncrypted: vi.fn().mockResolvedValue(undefined),
  purgeLegacyPlainMlsState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/utils/scheduling/yieldToMainThread', () => ({
  yieldToMainThread: vi.fn().mockResolvedValue(undefined),
}));

import { setupMessageHandler } from './setupMessageHandler';
import { unregisterMlsStatePersister } from '../mlsStatePersisterRegistry';
import { createMlsServiceStub } from '../test/fixtures/mlsServiceStub';
import {
  createTestConversations,
  createTestMessageReactions,
} from '../test/fixtures/conversationMap';
import { flushMacrotask } from '../../../test/flush';

const live = { bufferUi: true, showOverlay: false };

/** Builds the pipeline and returns the persister it wired, with its service's checkpoint spy. */
function wire() {
  const mlsService = createMlsServiceStub({});
  setupMessageHandler({
    mlsService,
    storage: null,
    userId: 'user-a',
    deviceKey: () => 'device-key',
    historyBaseUrl: 'https://hist',
    conversations: createTestConversations([]),
    messageReactions: createTestMessageReactions(),
    recoveryTimers: new Map(),
    getSelectedContact: () => null,
    setSelectedContact: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    addMessageToChat: vi.fn().mockResolvedValue(undefined),
    loadHistoryForConversation: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
  } as never);
  const persister = fake.persisters[fake.persisters.length - 1];
  return { persister, persistCheckpoint: mlsService.persistCheckpoint as ReturnType<typeof vi.fn> };
}

/** One live drain that only received one application frame. */
async function receiveOnlyDrain(persister: MlsStatePersister) {
  persister.onBulkIngestStart();
  persister.scheduleDeferred();
  await persister.onBulkIngestEnd(live);
  await flushMacrotask();
}

describe('setupMessageHandler wires the server checkpoint-skip mode into its persister', () => {
  beforeEach(() => {
    fake.mode = 'off';
    fake.nativeMobile = true;
    fake.persisters.length = 0;
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });
  afterEach(() => {
    unregisterMlsStatePersister();
    vi.restoreAllMocks();
  });

  it('mode off: a receive-only drain checkpoints', async () => {
    const { persister, persistCheckpoint } = wire();
    persistCheckpoint.mockClear();
    await receiveOnlyDrain(persister);
    expect(persistCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('mode on, on a phone: a receive-only drain defers its checkpoint', async () => {
    fake.mode = 'on';
    const { persister, persistCheckpoint } = wire();
    persistCheckpoint.mockClear();
    await receiveOnlyDrain(persister);
    expect(persistCheckpoint).not.toHaveBeenCalled();
  });

  it('mode on, off native mobile: still checkpoints', async () => {
    fake.mode = 'on';
    fake.nativeMobile = false;
    const { persister, persistCheckpoint } = wire();
    persistCheckpoint.mockClear();
    await receiveOnlyDrain(persister);
    expect(persistCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('the mode is read at each drain end: on, then an emergency off, checkpoints the next drain', async () => {
    fake.mode = 'on';
    const { persister, persistCheckpoint } = wire();
    persistCheckpoint.mockClear();
    await receiveOnlyDrain(persister);
    expect(persistCheckpoint).not.toHaveBeenCalled();
    fake.mode = 'off';
    await receiveOnlyDrain(persister);
    expect(persistCheckpoint).toHaveBeenCalledTimes(1);
  });
});
