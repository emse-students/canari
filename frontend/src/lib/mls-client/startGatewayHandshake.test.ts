/**
 * THE HANDSHAKE STARTED AHEAD OF THE CODE THAT WILL USE IT.
 *
 * `startGatewayHandshake` exists so the socket and the MLS state load stop queuing behind one
 * another - 182 ms of a 1308 ms cold start, measured on production 2026-09-16. Its whole contract is
 * that it can be created 200 ms before anything awaits it, which puts two obligations on it that a
 * synchronous connect never had:
 *
 *  - it must NEVER reject, because a rejection with nobody listening is an unhandled rejection, and
 *    on this path it is also a `SessionExpiredError` reported to nobody, and
 *  - `openGatewayConnection` must treat the result EXACTLY as it treats a connect it made itself -
 *    same state, same re-throw, same return value - or the boot and the reconnect have quietly
 *    become two different code paths.
 */
const getTokenMock = vi.hoisted(() => vi.fn(() => Promise.resolve('jwt-access-token')));
const getIsTabLeaderMock = vi.hoisted(() => vi.fn(() => true));

vi.mock('$lib/stores/auth', () => ({
  getToken: () => getTokenMock(),
}));

vi.mock('$lib/mls-client/tabLeader', () => ({
  getIsTabLeader: () => getIsTabLeaderMock(),
  initTabLeadershipAsync: vi.fn(),
  resetTabLeaderStateForTests: vi.fn(),
  getTabLeaderElectionIdForTests: vi.fn(() => 'test-id'),
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startGatewayHandshake, openGatewayConnection } from './initializeConnection';
import type { ConnectionDeps } from './initializeConnection';
import type { IMlsService } from './IMlsService';

/** Only the seams these two functions touch; everything else would be scenery. */
const makeDeps = (connect: ReturnType<typeof vi.fn>) => {
  const setIsWsConnected = vi.fn();
  const setReconnectAttempts = vi.fn();
  const mlsService = {
    connect,
    onDisconnect: vi.fn(),
    fetchPendingMessages: vi.fn().mockResolvedValue(undefined),
    sendDisconnect: vi.fn(),
  } as unknown as IMlsService;
  const deps = {
    mlsService,
    userId: 'u1',
    deviceKeyB64: 'k',
    scheduleReconnect: vi.fn(),
    setIsWsConnected,
    setReconnectAttempts,
    processDeviceInvitationsLocally: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
    onGroupMissing: vi.fn().mockResolvedValue(undefined),
  } as unknown as ConnectionDeps;
  return { deps, mlsService, setIsWsConnected, setReconnectAttempts };
};

describe('a handshake started before anything awaits it', () => {
  beforeEach(() => {
    getTokenMock.mockClear();
    getTokenMock.mockResolvedValue('jwt-access-token');
    getIsTabLeaderMock.mockReturnValue(true);
  });

  it('opens the socket without being awaited', async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const { deps } = makeDeps(connect);

    const started = startGatewayHandshake(deps);

    await expect(started).resolves.toBeNull();
    expect(connect).toHaveBeenCalledWith('jwt-access-token');
  });

  it('settles to the error instead of rejecting, because nobody is listening yet', async () => {
    // THE WHOLE REASON THE RETURN TYPE IS `Error | null`. This promise lives unattended for the
    // length of an MLS state load; a rejecting one would be an unhandled rejection every time the
    // gateway is unreachable, which is the ordinary case on a train.
    const connect = vi.fn().mockRejectedValue(new Error('gateway down'));
    const { deps } = makeDeps(connect);

    await expect(startGatewayHandshake(deps)).resolves.toBeInstanceOf(Error);
  });

  it('opens no socket on a follower tab, and says which tab it was', async () => {
    getIsTabLeaderMock.mockReturnValue(false);
    const connect = vi.fn();
    const { deps } = makeDeps(connect);

    expect(startGatewayHandshake(deps)).toBeNull();
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('openGatewayConnection handed a handshake already in flight', () => {
  beforeEach(() => {
    getTokenMock.mockClear();
    getTokenMock.mockResolvedValue('jwt-access-token');
    getIsTabLeaderMock.mockReturnValue(true);
  });

  it('adopts it rather than opening a second socket', async () => {
    // A SECOND `connect` WOULD BE A SECOND SOCKET, and the gateway would deliver to whichever it
    // decided was current. The started handshake is the connection, not a warm-up for one.
    const connect = vi.fn().mockResolvedValue(undefined);
    const { deps, setIsWsConnected, setReconnectAttempts } = makeDeps(connect);
    const started = startGatewayHandshake(deps);

    await expect(openGatewayConnection(deps, started)).resolves.toBe(true);

    expect(connect).toHaveBeenCalledOnce();
    expect(setIsWsConnected).toHaveBeenCalledWith(true);
    expect(setReconnectAttempts).toHaveBeenCalledWith(0);
  });

  it('reports a failed handshake exactly as it reports one it made itself', async () => {
    const connect = vi.fn().mockRejectedValue(new Error('gateway down'));
    const { deps, setIsWsConnected } = makeDeps(connect);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const started = startGatewayHandshake(deps);

    await expect(openGatewayConnection(deps, started)).resolves.toBe(false);

    expect(setIsWsConnected).toHaveBeenCalledWith(false);
  });

  it('still re-throws a session expiry, so the caller stops retrying', async () => {
    // THE ONE ERROR THAT IS NOT A TRANSPORT FAILURE. It travelled through a rejection before and
    // travels through a resolved value now; what must not change is that it reaches the caller as
    // a throw, because backoff against an expired session is an infinite loop.
    const expired = new Error('session expired');
    expired.name = 'SessionExpiredError';
    const connect = vi.fn().mockRejectedValue(expired);
    const { deps } = makeDeps(connect);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const started = startGatewayHandshake(deps);

    await expect(openGatewayConnection(deps, started)).rejects.toThrow('session expired');
  });

  it('opens one itself when handed nothing, which is what the reconnect path does', async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const { deps } = makeDeps(connect);

    await expect(openGatewayConnection(deps)).resolves.toBe(true);

    expect(connect).toHaveBeenCalledWith('jwt-access-token');
  });
});
