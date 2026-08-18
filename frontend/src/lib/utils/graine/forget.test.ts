import type { StoredGraineSession } from '$lib/db/types';
import { forgetCommunityGraine } from './forget';
import {
  cacheGraineSession,
  cachedGraineSession,
  registerChannelWorkspace,
  registerCommunityHistoryVisibility,
  setGraineRuntime,
  workspaceForChannel,
} from './runtime';
import { requestCommunityHistory, resetGraineRepairState } from './repair';

/**
 * A community leaving the device takes its seeds with it (WP-60).
 *
 * Everything here is about residue that NOTHING else would ever come back for: a purge that drops
 * the sidebar entry while leaving key material behind looks complete from every screen in the app.
 */

const listWorkspaceMembers = vi.fn();
vi.mock('$lib/services/ChannelService', () => ({
  ChannelService: class {
    listWorkspaceMembers(...args: unknown[]) {
      return listWorkspaceMembers(...args);
    }
  },
}));

const forgetMirror = vi.fn();
vi.mock('./graineMirror', () => ({
  mirrorGraineSeed: vi.fn(),
  forgetGraineChannelMirror: (channelId: string) => forgetMirror(channelId),
}));

function mkSession(over: Partial<StoredGraineSession> = {}): StoredGraineSession {
  return {
    workspaceId: 'ws-1',
    channelId: 'chan-1',
    sessionId: 's-1',
    senderId: 'bob',
    seedB64: 'seed',
    firstIndex: 0,
    createdAt: 1,
    ...over,
  };
}

let held: StoredGraineSession[];
let deleted: string[];
let sendMessage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetGraineRepairState();
  forgetMirror.mockClear();
  listWorkspaceMembers.mockResolvedValue([{ userId: 'alice' }, { userId: 'bob' }]);
  held = [mkSession(), mkSession({ sessionId: 's-2', channelId: 'chan-2' })];
  deleted = [];
  sendMessage = vi.fn().mockResolvedValue(undefined);
  setGraineRuntime({
    storage: {
      getGraineSessionsForWorkspace: async () => held,
      deleteGraineSessionsForWorkspace: async (workspaceId: string) => {
        deleted.push(workspaceId);
        const gone = held.length;
        held = [];
        return gone;
      },
    } as never,
    deviceKeyB64: 'device-key',
    userId: 'alice',
    mlsService: { sendMessage, distributionGroupFor: () => 'dist-group' } as never,
  });
});

afterEach(() => {
  setGraineRuntime(null);
});

describe('forgetCommunityGraine', () => {
  it('drops the durable seeds, the decrypted cache and the channel map together', async () => {
    cacheGraineSession(mkSession());
    registerChannelWorkspace('chan-1', 'ws-1');

    await expect(forgetCommunityGraine('ws-1')).resolves.toBe(2);

    expect(deleted).toEqual(['ws-1']);
    // The cache is what this tab answers from until it reloads: leaving it holding the seed would
    // let an already-open salon keep decrypting a community the device has just been purged of.
    expect(cachedGraineSession('s-1')).toBeNull();
    expect(workspaceForChannel('chan-1')).toBeNull();
  });

  it('unmirrors every channel it held a seed for, once each', async () => {
    held = [
      mkSession(),
      mkSession({ sessionId: 's-2' }),
      mkSession({ sessionId: 's-3', channelId: 'chan-2' }),
    ];

    await forgetCommunityGraine('ws-1');

    expect(forgetMirror.mock.calls.map(([id]) => id).sort()).toEqual(['chan-1', 'chan-2']);
  });

  it('lets a rejoining member ask for the history again', async () => {
    registerCommunityHistoryVisibility('ws-1', 'shared');
    // A device that already holds seeds asks nothing, so the ask is only visible on an empty one.
    held = [];
    // First ask: this device holds nothing, so the request goes out.
    await requestCommunityHistory('ws-1');
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // Without the purge clearing `historyAsked`, the ask after a rejoin is silently skipped and the
    // member sits in front of an empty salon with nothing anywhere saying why.
    await forgetCommunityGraine('ws-1');
    await requestCommunityHistory('ws-1');
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('purges the durable rows even when the seeds cannot be read', async () => {
    setGraineRuntime({
      storage: {
        getGraineSessionsForWorkspace: async () => {
          throw new Error('device key is wrong');
        },
        deleteGraineSessionsForWorkspace: async (workspaceId: string) => {
          deleted.push(workspaceId);
          return 4;
        },
      } as never,
      deviceKeyB64: 'device-key',
      userId: 'alice',
      mlsService: { sendMessage, distributionGroupFor: () => 'dist-group' } as never,
    });

    // The delete is keyed by workspaceId, a clear column - it needs no device key. An unreadable
    // store must not be the reason key material survives.
    await expect(forgetCommunityGraine('ws-1')).resolves.toBe(4);
    expect(deleted).toEqual(['ws-1']);
  });

  it('says so rather than pretending, when no runtime is wired', async () => {
    setGraineRuntime(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(forgetCommunityGraine('ws-1')).resolves.toBe(0);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('its seeds stay on this device'));
    warn.mockRestore();
  });
});
