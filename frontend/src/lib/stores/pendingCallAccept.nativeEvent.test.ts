// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * THE NATIVE SIDE SAYS AN ANSWER WAITS, AND THE PAGE DRAINS IT - ONCE (calls.md, "The iPhone's
 * answer never joined"). Driven through a real window event against a mocked native command: the
 * file is drained by `read_and_clear_pending_call_accept` and the answer handed over once, even when
 * the event fires twice.
 */
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('$lib/utils/sessionLog', () => ({ appendLog: vi.fn() }));
vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: () => true }));

const {
  NATIVE_CALL_ACCEPT_EVENT,
  listenForNativeCallAccept,
  setPendingCallAcceptHandler,
  setSessionCaughtUp,
  takePendingCallAccept,
} = await import('./pendingCallAccept');

/** The native file: present once, then removed by the drain that read it. */
function nativeFileHolding(answer: object): void {
  let file: string | null = JSON.stringify(answer);
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd !== 'read_and_clear_pending_call_accept') throw new Error(`unexpected ${cmd}`);
    const raw = file;
    file = null;
    return raw;
  });
}

/** Lets the drains the events started run to their end. */
const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  setSessionCaughtUp(false);
  setPendingCallAcceptHandler(null);
  takePendingCallAccept();
  invoke.mockReset();
});

describe('canari:call-accept', () => {
  it('drains the native file and hands the answer over once, even when it fires twice', async () => {
    const handler = vi.fn((_why: string) => takePendingCallAccept());
    setPendingCallAcceptHandler(handler);
    setSessionCaughtUp(true);
    nativeFileHolding({
      groupId: 'group-1',
      callId: 'call-1',
      callerId: 'peer',
      hasVideo: false,
      acceptedAt: Date.now(),
    });
    const stop = listenForNativeCallAccept();

    window.dispatchEvent(new CustomEvent(NATIVE_CALL_ACCEPT_EVENT));
    window.dispatchEvent(new CustomEvent(NATIVE_CALL_ACCEPT_EVENT));
    await settle();

    expect(invoke).toHaveBeenCalledWith('read_and_clear_pending_call_accept');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.results[0]?.value).toMatchObject({ callId: 'call-1', groupId: 'group-1' });
    stop();
  });

  it('at the PIN gate the answer is held, then acted on at the catch-up', async () => {
    const handler = vi.fn();
    setPendingCallAcceptHandler(handler);
    nativeFileHolding({ groupId: 'g', callId: 'c', acceptedAt: Date.now() });
    const stop = listenForNativeCallAccept();

    window.dispatchEvent(new CustomEvent(NATIVE_CALL_ACCEPT_EVENT));
    await settle();
    expect(handler).not.toHaveBeenCalled();

    setSessionCaughtUp(true);
    expect(handler).toHaveBeenCalledTimes(1);
    stop();
  });

  it('drains nothing once unsubscribed', async () => {
    nativeFileHolding({ groupId: 'g', callId: 'c', acceptedAt: Date.now() });
    listenForNativeCallAccept()();
    window.dispatchEvent(new CustomEvent(NATIVE_CALL_ACCEPT_EVENT));
    await settle();
    expect(invoke).not.toHaveBeenCalled();
  });
});
