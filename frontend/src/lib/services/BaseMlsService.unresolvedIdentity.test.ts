/**
 * A PLACEHOLDER IS NOT A MEMBER - the seam that publishes an identity, asserted before one exists.
 *
 * Measured on production on 2026-08-27. A client reached `updateInvitationStatus` before its own
 * identity had resolved and the server stored `userId = 'unknown'`, `deviceId = 'pending'` as an
 * ACTIVE member of a real conversation, 0.84 s before its two real members joined. For 134 minutes
 * the placeholder held the peer's place: the peer's own two devices sat `pending`, the server
 * answered `No active membership` twenty-one times, every fetch returned nothing, and both
 * directions of the conversation were lost until a reinstall minted a new device id.
 *
 * WHAT MAKES THIS WORTH ITS OWN FILE is that the class already knew. It initialises both fields to
 * these exact literals and guards on them in three other places - `settleBarrier`,
 * `fetchPendingMessages`, `resolveDeviceId` - so the value was documented as a non-identity and one
 * seam published it anyway. The literals are therefore named constants now, and the assertion is
 * that the seam refuses, LOUDLY, rather than that a caller remembers to check.
 *
 * The refusal is a THROW and not a skip because the two are different facts to the one caller that
 * decides: an unresolved identity resolves by itself and the next cycle succeeds. Every call site
 * is fire-and-forget and re-driven, so a refusal costs one cycle; a placeholder written into a
 * roster costs a conversation, and nothing collects it afterwards.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BaseMlsService,
  UnresolvedIdentityError,
  UNRESOLVED_USER_ID,
  UNRESOLVED_DEVICE_ID,
} from '$lib/services/BaseMlsService';

/** @see BaseMlsService.mailboxBarrier.test.ts - same reason the cast is what instantiates the base. */
abstract class Harness extends BaseMlsService {}

const makeService = (): BaseMlsService =>
  new (Harness as unknown as new (platform: 'web' | 'tauri') => BaseMlsService)('web');

/** Installs a test double over the delivery client, which no widened interface can describe. */
const poke = (svc: BaseMlsService, patch: Record<string, unknown>): void => {
  Object.assign(svc, patch);
};

describe('publishing a membership before the identity exists', () => {
  let svc: BaseMlsService;
  /** The wire. Its call count IS the assertion: what must not happen is a request. */
  let publish: ReturnType<typeof vi.fn>;
  let complaint: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    svc = makeService();
    publish = vi.fn().mockResolvedValue(undefined);
    poke(svc, { delivery: { updateInvitationStatus: publish } });
    complaint = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses the unresolved deviceId rather than letting the server store it', async () => {
    await expect(
      svc.updateInvitationStatus(UNRESOLVED_DEVICE_ID, 'real-user', 'group-a', 'active')
    ).rejects.toBeInstanceOf(UnresolvedIdentityError);

    expect(publish).not.toHaveBeenCalled();
    // The report is the point: a swallowed refusal in a fire-and-forget caller leaves nothing else.
    expect(complaint).toHaveBeenCalledWith(expect.stringContaining('[IDENTITY]'));
  });

  it('refuses the unresolved userId, and names WHICH field was missing', async () => {
    const refusal = await svc
      .updateInvitationStatus('real-device', UNRESOLVED_USER_ID, 'group-a', 'active')
      .catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(UnresolvedIdentityError);
    // Typed, not parsed out of prose: the caller that retries must tell this from a 500.
    expect((refusal as UnresolvedIdentityError).field).toBe('userId');
    expect((refusal as UnresolvedIdentityError).seam).toBe('updateInvitationStatus');
    expect(publish).not.toHaveBeenCalled();
  });

  it('refuses an EMPTY identifier too - absent and placeholder are the same non-identity here', async () => {
    await expect(
      svc.updateInvitationStatus('real-device', '', 'group-a', 'active')
    ).rejects.toBeInstanceOf(UnresolvedIdentityError);
    expect(publish).not.toHaveBeenCalled();
  });

  it('publishes normally once both identifiers are real - the guard is not a gate on the path', async () => {
    await svc.updateInvitationStatus('real-device', 'real-user', 'group-a', 'active');

    expect(publish).toHaveBeenCalledWith('real-device', 'real-user', 'group-a', 'active');
    expect(complaint).not.toHaveBeenCalled();
  });

  it('refuses a DEMOTION under a placeholder as well, so no row is created by the cleanup path', async () => {
    // `pending` creates a row exactly as `active` does when none exists; only the server's own
    // demotion path may touch a placeholder row, and it does not go through this seam.
    await expect(
      svc.updateInvitationStatus(UNRESOLVED_DEVICE_ID, UNRESOLVED_USER_ID, 'group-a', 'pending')
    ).rejects.toBeInstanceOf(UnresolvedIdentityError);
    expect(publish).not.toHaveBeenCalled();
  });
});
