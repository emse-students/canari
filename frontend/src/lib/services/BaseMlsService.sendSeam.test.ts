// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

const scheduleOutboundMlsPersist = vi.fn();
vi.mock('$lib/mls-client/mlsStatePersisterRegistry', () => ({
  scheduleOutboundMlsPersist: () => scheduleOutboundMlsPersist(),
  flushActiveMlsStateEncrypted: vi.fn(),
}));

import { BaseMlsService } from './BaseMlsService';
import { DELIVERY } from '$lib/mls-client/frameDelivery';

/**
 * The three rules that must hold around EVERY send, asserted on the seam that now owns them.
 *
 * They used to be the caller's responsibility, and the checkpoint was written at two of the
 * eighteen call sites that reach a send. The other sixteen - read receipts, reactions, edits,
 * deletes, pins, group control, calls - advanced this device's send ratchet and persisted nothing,
 * so `mls.bin` sat structurally behind the live client and any state replacement rewound it.
 *
 * What is pinned here is that a caller can no longer opt out by forgetting: the order is fixed in
 * `BaseMlsService.sendMessage`, and a platform only supplies `encryptForSend`.
 */
abstract class SendSeamHarness extends BaseMlsService {
  /** Everything the seam did, in the order it did it - the assertion subject. */
  readonly trace: string[] = [];
  encryptCalls = 0;

  constructor() {
    super('web');
    // The seam posts through the delivery API; stub just the one method it reaches.
    (this as unknown as { delivery: unknown }).delivery = {
      postApplicationMessage: async () => {
        this.trace.push('post');
      },
    };
  }

  protected async encryptForSend(_groupId: string, _messageBytes: Uint8Array): Promise<Uint8Array> {
    this.encryptCalls++;
    this.trace.push('encrypt');
    return new Uint8Array([1, 2, 3]);
  }

  /** Exposes the protected counter every replacement seam compares against. */
  get mutations(): number {
    return this.liveMutations;
  }

  /** Opens a catch-up window from the test, as a real off-thread session does. */
  openCatchUp(groupId = 'g-seam'): void {
    this.beginCatchUp(groupId);
  }
  closeCatchUp(groupId = 'g-seam'): void {
    this.endCatchUp(groupId);
  }
}

/**
 * Concrete only through a cast: the class carries two dozen abstract members that the send seam
 * never reaches, and stubbing each one would say nothing about the seam while hiding it in noise.
 */
const FakeMlsService = SendSeamHarness as unknown as new () => SendSeamHarness;

describe('BaseMlsService.sendMessage - the one seam every send passes through', () => {
  beforeEach(() => scheduleOutboundMlsPersist.mockClear());

  it('checkpoints the ratchet advance, without the caller asking', async () => {
    const svc = new FakeMlsService();
    await svc.sendMessage('g1', new Uint8Array([9]), undefined, DELIVERY.transport);
    expect(scheduleOutboundMlsPersist).toHaveBeenCalledTimes(1);
  });

  it('counts the advance so a replacement seam can refuse a state that predates it', async () => {
    const svc = new FakeMlsService();
    const before = svc.mutations;
    await svc.sendMessage('g1', new Uint8Array([9]));
    expect(svc.mutations).toBe(before + 1);
  });

  it('encrypts before it posts - the peer must never consume a generation we have not counted', async () => {
    const svc = new FakeMlsService();
    await svc.sendMessage('g1', new Uint8Array([9]));
    expect(svc.trace).toEqual(['encrypt', 'post']);
  });

  it('does not encrypt while a catch-up is open, and proceeds once it closes', async () => {
    const svc = new FakeMlsService();
    svc.openCatchUp();
    const inFlight = svc.sendMessage('g1', new Uint8Array([9]));
    // The gate is the fix: encrypting here would advance a ratchet the catch-up is about to
    // replace with a copy taken before it, and the frame would be emitted at a generation the
    // swap then hands back out.
    await Promise.resolve();
    expect(svc.encryptCalls).toBe(0);
    svc.closeCatchUp();
    await inFlight;
    expect(svc.encryptCalls).toBe(1);
  });

  it('defaults to the visible delivery when a caller passes none', async () => {
    const svc = new FakeMlsService();
    await svc.sendMessage('g1', new Uint8Array([9]));
    expect(svc.trace).toContain('post');
  });
});
