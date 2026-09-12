/**
 * Session watchdog extracted from useChatSession: startSyncWatchdog (recovery of not-ready groups).
 */
import { SvelteSet } from 'svelte/reactivity';
import {
  requestReAdd,
  recoverForkedGroup,
  cancelReAdd,
  isReAddDue,
} from '$lib/utils/chat/recovery';
import { clearGroupNotReady, enumerateNotReadyGroups } from '$lib/utils/chat/notReadyRegistry';
import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';
import {
  getEpochGapSince,
  clearEpochGap,
  anyEpochGapArmed,
} from '$lib/utils/chat/epochGapRegistry';
import { getIsTabLeader } from '$lib/utils/chat/connection';
import type { SessionContext, ChatSessionCallbacks } from './sessionTypes';
import { makeRecoveryDeps } from './sessionAuth';

/**
 * Timer-based safety net for a stuck epoch gap. The pipeline's own escalation is REACTIVE
 * (only fires when another undecryptable frame arrives): if a group enters an epoch gap and the
 * peer then goes quiet, no frame escalates and no commit clears it - the group stays local but
 * `isGroupHealthy` reports false, freezing the outbox forever. Past this delay the watchdog
 * forces forget + re-add so sends can resume. Slightly longer than the reactive threshold
 * (EPOCH_GAP_ESCALATION_MS = 30 s) so the reactive path gets first chance.
 */
const STUCK_EPOCH_GAP_MS = 45_000;

/** How often the tick runs. Set by the stuck-gap net above, the only net needing this resolution. */
const WATCHDOG_TICK_MS = 5_000;

/**
 * How long the recovery sweep waits before walking the candidate groups again.
 *
 * **THE SWEEP IS A SAFETY NET AND NOTHING ELSE.** Every real trigger for a re-add is reactive and
 * already fires its own immediate attempt: a frame for an unknown group, an `epoch_rejected`, a
 * refused send, a Welcome that never came. This sweep exists for the one case none of them cover -
 * a group that is not ready, with nothing left arriving to say so. That is rare, and it was being
 * hunted every five seconds.
 *
 * Chosen with the user 2026-09-12 ("evenementiel + filet long"), against the measured cost: over a
 * three-and-a-half minute idle window on production, the five-second tick produced **51 `throttled`
 * lines, 5.7% of everything the console held**, plus a WASM `get_groups()` crossing per tick - for
 * groups whose sixty-second cooldown made every one of those passes a no-op by construction.
 *
 * The price is honest and bounded: a candidate that appears with no reactive path behind it waits
 * up to this long for its first attempt. Nothing else moves - {@link RECOVERY_TIMEOUT_MS} still
 * floors every caller at one attempt per minute, so a reactive trigger arriving in between is
 * served at once, which is the half of the design this constant does not touch.
 */
const RECOVERY_SWEEP_MS = 5 * 60_000;

/**
 * Starts the universal watchdog, the SINGLE owner of the re-add cadence. It drives recovery for
 * every group lacking local WASM state - both live conversations that lost their state AND groups
 * marked not-ready that have no conversation record yet (a commit arrived before the Welcome,
 * tracked in the persistent `mls_not_ready_since` registry).
 *
 * It routes through the single recovery seam `requestReAdd` (external join, else welcome_request).
 * Reactive paths (unknown group, out-of-sync) fire an immediate first attempt; this watchdog owns
 * the rest. Overwrites any previous timer.
 *
 * **TWO NETS, ONE TIMER, AND THEY ANSWER DIFFERENT QUESTIONS.** The tick runs at
 * {@link WATCHDOG_TICK_MS} because the stuck-epoch-gap net needs that resolution against a 45 s
 * threshold. The recovery sweep does not, and it used to inherit the same cadence anyway: it asked
 * `requestReAdd` twelve times a minute about groups whose own cooldown is sixty seconds, so eleven
 * of those twelve could only ever return at the throttle - and each wrote a line saying so.
 *
 * **IT LEARNT BY FAILING WHAT A FACT COULD HAVE TOLD IT.** `isReAddDue` reads the very clock the
 * seam throttles on, and a caller that DRIVES a cadence is the one caller entitled to read it. It
 * is not a silencer: a reactive caller still asks and still gets a throttle line, because it
 * carries new information and the rate at which it arrives is a measurement worth keeping.
 *
 * So the tick now returns before it crosses into WASM whenever nothing could act: no gap armed
 * ({@link anyEpochGapArmed}) and no sweep owed. The first tick after a start always sweeps, so a
 * session resuming with a not-ready group does not wait out {@link RECOVERY_SWEEP_MS} for it.
 */
export function startSyncWatchdogImpl(ctx: SessionContext, cb: ChatSessionCallbacks): void {
  if (ctx.timers.syncWatchdog !== null) clearInterval(ctx.timers.syncWatchdog);
  // Per-start, not module-global: a re-start is a new session (or a reconnection), and it owes the
  // groups it inherits an immediate look rather than the tail of the previous run's sweep clock.
  let lastSweepAt = 0;
  ctx.timers.syncWatchdog = setInterval(() => {
    if (!getIsTabLeader()) return;
    const now = Date.now();
    const sweeping = now - lastSweepAt >= RECOVERY_SWEEP_MS;
    if (!sweeping && !anyEpochGapArmed()) return;

    const recoveryDeps = makeRecoveryDeps(ctx, cb);
    const localGroups = new SvelteSet(recoveryDeps.mlsService.getLocalGroups());
    if (sweeping) lastSweepAt = now;

    // Union of candidate groups: live conversations + not-ready registry (covers pre-conversation
    // unknown groups). A single set so each group is evaluated once per poll.
    //
    // THE GROUP ID COMES FROM THE ROW, NEVER FROM THE MAP KEY. Both are strings and for a
    // conversation created on this device they are equal, which is why reading the key survived so
    // long - but a direct conversation learnt from a Welcome is keyed by the PEER'S USER ID
    // (`deriveConversationIdentity`), and feeding that to `requestReAdd` asked the server about a
    // group id no `dm_groups` row can ever carry. The answer is a CONFIRMED ABSENT, which returns
    // before the throttle is armed - so every received DM cost two HTTP round trips every five
    // seconds, for the whole session, while the recovery those calls exist to drive never ran for
    // any of them.
    //
    // The channel exclusion stays on the KEY, which is what names a channel (`channel_<id>`); the
    // guard below still covers ids coming from the not-ready registry.
    const candidates = new SvelteSet<string>();
    for (const [key, convo] of cb.conversations) {
      if (isChannelConversationId(key)) continue;
      candidates.add(convo.id);
    }
    for (const id of enumerateNotReadyGroups(recoveryDeps.userId)) candidates.add(id);

    for (const id of candidates) {
      // WASM has state -> group is operational (or Welcome in transit) -> no re-add needed.
      // Do NOT test convo.isReady: if isReady=true but WASM lost state during the session,
      // the watchdog must still trigger recovery.
      if (localGroups.has(id)) {
        // Healthy group: clear recovery bookkeeping (cooldown + persistent not-ready marker) so a
        // stale marker cannot trigger a spurious re-add if the group later becomes not-ready. It
        // is a belt-and-braces sweep and belongs with the sweep - every path that actually joins a
        // group clears both itself, the moment it joins.
        if (sweeping) {
          clearGroupNotReady(recoveryDeps.userId, id);
          cancelReAdd(id);
        }
        // Safety net for a stuck epoch gap: the group is in WASM but frozen behind the current
        // epoch, and no incoming frame/commit is coming to escalate or resolve it. Force the
        // forget + re-Welcome so the outbox (gated on !isInEpochGap) unfreezes.
        const gapSince = getEpochGapSince(id);
        if (gapSince !== undefined && now - gapSince > STUCK_EPOCH_GAP_MS) {
          cb.log(
            `[SYNC_WATCHDOG] Group ${id.slice(0, 8)}... epoch gap stuck >${STUCK_EPOCH_GAP_MS / 1000}s - forget + welcome_request`
          );
          clearEpochGap(id);
          recoverForkedGroup(id, recoveryDeps).catch((e: unknown) =>
            cb.log(`[SYNC_WATCHDOG] gap recovery failed for ${id}: ${String(e)}`)
          );
        }
        continue;
      }
      if (!sweeping) continue;
      // Channels use AES-GCM, not MLS - never part of MLS recovery.
      if (isChannelConversationId(id)) {
        clearGroupNotReady(recoveryDeps.userId, id);
        continue;
      }
      // The seam still owns the pacing; this only declines to ask a question already answered.
      if (!isReAddDue(id)) continue;
      // Not in WASM -> drive the single recovery seam. It marks the group not-ready on the first
      // attempt and throttles to one attempt per RECOVERY_TIMEOUT_MS.
      requestReAdd(id, recoveryDeps).catch((e: unknown) =>
        cb.log(`[SYNC_WATCHDOG] requestReAdd failed for ${id}: ${String(e)}`)
      );
    }
  }, WATCHDOG_TICK_MS);
}
