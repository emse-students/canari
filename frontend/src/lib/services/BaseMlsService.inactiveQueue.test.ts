// @vitest-environment happy-dom
/**
 * OUT OF FRONT ON AN iPHONE, THE PAGE CONSUMES NO QUEUED FRAME (`appActive.ts`).
 *
 * The notification extension decrypts read-only from `mls.bin`; a frame the page has already
 * consumed has spent its secret, so the server's push for it would be announced with no content.
 * So while the app is inactive every queued frame is left exactly as the server holds it - not
 * decrypted, not ACKed, re-admissible by the pull on return - and the server is asked to push it
 * now. Each case below fails without the gate.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('$lib/utils/appVersion', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isIosTauriRuntime: () => true,
}));

const { BaseMlsService } = await import('$lib/services/BaseMlsService');
type Service = InstanceType<typeof BaseMlsService>;
import type { DeliveryChannel } from '$lib/mls-client/incomingDelivery';
import type { MlsPerGroupScheduler, MlsQueuedMessage } from '$lib/mls-client/mlsPerGroupScheduler';

abstract class Harness extends BaseMlsService {}
const makeService = (): Service =>
  new (Harness as unknown as new (platform: 'web' | 'tauri') => Service)('tauri');

const inner = (svc: Service) =>
  svc as unknown as {
    messageScheduler: MlsPerGroupScheduler;
    enqueueMessage(msg: MlsQueuedMessage, channel: DeliveryChannel): void;
  };

const row = (queuedMessageId: string, groupId = 'group-a'): MlsQueuedMessage => ({
  senderId: 'alice',
  ciphertext: new Uint8Array([1]),
  groupId,
  isWelcome: false,
  isCommit: false,
  queuedMessageId,
});

/** What iOS tells the page (`CanariPushActiveToPage`). */
function active(value: boolean) {
  (window as unknown as Record<string, unknown>).__canariActive = value;
  window.dispatchEvent(new CustomEvent('canari:active', { detail: { active: value } }));
}

describe('a queued frame while the iPhone app is inactive', () => {
  let svc: Service;
  let applied: string[];
  let ack: ReturnType<typeof vi.fn>;
  let pushNow: ReturnType<typeof vi.fn>;
  let pull: ReturnType<typeof vi.fn>;

  const deliver = async (msg: MlsQueuedMessage, channel: DeliveryChannel = 'live') => {
    inner(svc).enqueueMessage(msg, channel);
    await inner(svc).messageScheduler.waitUntilIdle();
    // `onDrainEnd` fires the ack and the push-now without awaiting them.
    await new Promise((r) => setTimeout(r, 0));
  };

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    active(true);
    svc = makeService();
    applied = [];
    ack = vi.fn().mockResolvedValue(undefined);
    pushNow = vi.fn().mockResolvedValue(undefined);
    pull = vi.fn().mockResolvedValue(undefined);
    Object.assign(svc, {
      userId: 'user-a',
      messageCallback: vi.fn(async (...args: unknown[]) => {
        applied.push((args[6] as { queuedMessageId: string }).queuedMessageId);
        return true;
      }),
      delivery: { ackMessages: ack, pushQueuedNow: pushNow, pullPendingMessagesJson: vi.fn() },
      fetchPendingMessages: pull,
    });
  });

  afterEach(() => {
    (svc as unknown as { offIosActive: (() => void) | null }).offIosActive?.();
    vi.restoreAllMocks();
    active(true);
  });

  it('ACTIVE: consumed and ACKed as before', async () => {
    await deliver(row('q-front'));
    expect(applied).toEqual(['q-front']);
    expect(ack).toHaveBeenCalledWith(['q-front']);
    expect(pushNow).not.toHaveBeenCalled();
  });

  it('INACTIVE: not decrypted, not ACKed, and the server is asked to push it now', async () => {
    active(false);
    await deliver(row('q-back'));
    expect(applied).toEqual([]);
    expect(ack).not.toHaveBeenCalled();
    expect(pushNow).toHaveBeenCalledWith(['q-back']);
  });

  it('a Welcome and a commit are left too - one rule, no frame-type split', async () => {
    active(false);
    await deliver({ ...row('q-welcome', 'group-w'), isWelcome: true });
    await deliver({ ...row('q-commit', 'group-c'), isCommit: true });
    expect(applied).toEqual([]);
    expect(ack).not.toHaveBeenCalled();
  });

  it('nothing remembers it: the pull on return is admitted and consumes it', async () => {
    active(false);
    await deliver(row('q-1'), 'live');
    active(true);
    expect(pull).toHaveBeenCalledTimes(1);
    await deliver(row('q-1'), 'pull');
    expect(applied).toEqual(['q-1']);
    expect(ack).toHaveBeenCalledWith(['q-1']);
  });

  it('returning with nothing left queued pulls nothing', async () => {
    active(false);
    active(true);
    expect(pull).not.toHaveBeenCalled();
  });

  it('THE BOUNDARY: a frame that started while active completes, banner and ACK, even if the app resigns mid-decrypt', async () => {
    let release!: () => void;
    Object.assign(svc, {
      messageCallback: vi.fn(async (...args: unknown[]) => {
        applied.push((args[6] as { queuedMessageId: string }).queuedMessageId);
        await new Promise<void>((r) => (release = r));
        return true;
      }),
    });
    inner(svc).enqueueMessage(row('q-edge'), 'live');
    await vi.waitFor(() => expect(applied).toEqual(['q-edge']));
    active(false);
    release();
    await inner(svc).messageScheduler.waitUntilIdle();
    await new Promise((r) => setTimeout(r, 0));
    expect(ack).toHaveBeenCalledWith(['q-edge']);
    expect(pushNow).not.toHaveBeenCalled();
  });

  it('a later frame of a group already left is left too, so its order is never inverted', async () => {
    // One drain, round robin: group-a's first frame is left (inactive), a frame with no queued row
    // in group-b is consumed and the app becomes active during it, then group-a's second frame.
    Object.assign(svc, {
      messageCallback: vi.fn(async (...args: unknown[]) => {
        applied.push((args[6] as { queuedMessageId?: string } | undefined)?.queuedMessageId ?? 'b');
        active(true);
        return true;
      }),
    });
    active(false);
    inner(svc).enqueueMessage(row('q-a1'), 'live');
    inner(svc).enqueueMessage({ ...row('', 'group-b'), queuedMessageId: undefined }, 'live');
    inner(svc).enqueueMessage(row('q-a2'), 'live');
    await inner(svc).messageScheduler.waitUntilIdle();
    expect(applied).toContain('b');
    expect(applied).not.toContain('q-a1');
    expect(applied).not.toContain('q-a2');
  });
});
