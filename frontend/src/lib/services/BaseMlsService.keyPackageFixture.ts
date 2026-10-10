import { BaseMlsService } from './BaseMlsService';

/**
 * The fields and REAL prototype methods a hand-built `BaseMlsService` context needs for
 * `externalJoin`'s wait on the device's published KeyPackage (`awaitOwnKeyPackagePublished`).
 * Spread into a context and give its `delivery` a `fetchDeviceKeyPackage`: the server's statement,
 * which {@link publishedKeyPackageAnswer} makes the ordinary "already published" one.
 */
const proto = BaseMlsService.prototype as unknown as Record<string, unknown>;

export const keyPackageWaitFields = () => ({
  keyPackageRoundInFlight: null as Promise<unknown> | null,
  keyPackageRoundsActive: 0,
  keyPackageRoundsSettled: 0,
  lastKeyPackageRoundFailure: null as { settled: number; error: unknown } | null,
  keyPackageRoundWaiters: [] as Array<(tornDown: boolean) => void>,
  currentDeviceKeyB64: 'device-key',
  awaitOwnKeyPackagePublished: proto.awaitOwnKeyPackagePublished,
  roundFailedForJoin: proto.roundFailedForJoin,
  noteKeyPackageRoundSettled: proto.noteKeyPackageRoundSettled,
  wakeKeyPackageRoundWaiters: proto.wakeKeyPackageRoundWaiters,
});

/** What the server answers for a device whose static KeyPackage it holds. */
export const publishedKeyPackageAnswer = () => ({
  kind: 'package' as const,
  device: { keyPackage: new Uint8Array(), deviceId: 'd' },
});
