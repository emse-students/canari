<script lang="ts">
  import { Ban, Copy, RotateCcw, Scissors, ShieldAlert } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import Button from '$lib/components/ui/Button.svelte';
  import { copyId } from '$lib/utils/copyId';
  import type { ReportedLive } from '$lib/moderation/api';
  import { liveStateLabels } from '$lib/moderation/liveState';
  import type { LiveCutResult, LiveWithdrawalLift, LiveWithdrawalResult } from '$lib/live/types';
  import { liftBroadcasterWithdrawal, LiveRefusalError } from '$lib/live/api';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { isTransportFailure } from '$lib/utils/transportFailure';
  import { describeModerationRefusal } from '$lib/moderation/moderationRefusal';
  import { LIVE_STRIKE_WINDOW_DAYS, LIVE_WITHDRAWAL_FROM_CUTS } from '$lib/live/constants';
  import ModerationLiveCutDialog from './ModerationLiveCutDialog.svelte';
  import ModerationLiveWithdrawDialog from './ModerationLiveWithdrawDialog.svelte';

  interface Props {
    /** The reported live's id (the report's `contentId`): the link to it, copyable. */
    liveId: string;
    /** The live as the queue states it. */
    live: ReportedLive;
    /** Formats an ISO instant in the reader's locale (the page's one formatter). */
    formatDate: (iso: string) => string;
    /** Resolves a report-reason code to its label. */
    reasonLabel: (code: string) => string;
    /** Told after a cut so the queue is read again. */
    onCut: (result: LiveCutResult) => void;
    /** Told after a withdrawal so the queue is read again. */
    onWithdrawn: (result: LiveWithdrawalResult) => void;
    /** Told the standing drawn here is stale (a withdrawal was refused as not due): re-read the queue. */
    onStale: () => void;
    /** Told after a lift (`lifted: false` is a repeat) so the queue is read again. */
    onLifted: (result: LiveWithdrawalLift) => void;
    /**
     * The caller moderates the broadcaster as a person (a BDE: one of its own spaces, 2026-11-02),
     * the server's `canMuteReportedUser`. Required: only true draws the withdrawal, so a caller that
     * forgets it shows no control rather than one the server would refuse.
     */
    mayActOnBroadcaster: boolean;
  }

  let {
    liveId,
    live,
    formatDate,
    reasonLabel,
    onCut,
    onWithdrawn,
    onStale,
    onLifted,
    mayActOnBroadcaster,
  }: Props = $props();

  let dialogOpen = $state(false);

  const stateLabel = $derived(liveStateLabels());

  /** Only a live that still has a row can be cut: `open`, or `ended` and not yet purged. */
  const cuttable = $derived(live.state === 'open' || live.state === 'ended');
  const broadcasterName = $derived(live.broadcasterName ?? '');

  const standing = $derived(live.broadcasterStanding);
  /** The ladder's 3rd step is a moderator's decision: offered only once the server says it is due. */
  const withdrawable = $derived(
    Boolean(standing?.withdrawalDue && live.broadcasterId && mayActOnBroadcaster)
  );
  let withdrawOpen = $state(false);

  /** A withdrawn right can be given back by the same people who may withdraw it. */
  const liftable = $derived(
    Boolean(standing?.withdrawnAt && live.broadcasterId && mayActOnBroadcaster)
  );
  let lifting = $state(false);
  let liftError = $state('');

  /** The sentence for a refused lift, decided on the typed code, never on a message. */
  function liftErrorText(e: unknown): string {
    // A refusal of the moderator's REACH (an institution's or a BDE's live, another BDE's spaces).
    const reach = describeModerationRefusal(e);
    if (reach) return reach;
    if (e instanceof LiveRefusalError) {
      if (e.code === 'LIVE_WITHDRAWAL_FORBIDDEN') return m.moderation_live_lift_forbidden();
      if (e.code === 'LIVE_ACCOUNT_INVALID') return m.moderation_live_withdraw_account_invalid();
    }
    return m.moderation_live_lift_error();
  }

  /**
   * Gives the broadcaster back the right to broadcast, after one confirmation naming them. A running
   * suspension is not lifted with it: the standing is derived from the cuts, which stay on record.
   */
  async function lift() {
    const userId = live.broadcasterId;
    if (!userId || lifting) return;
    // Taken BEFORE the confirmation: a second tap while it is open must not open another one.
    lifting = true;
    const yes = await showConfirm(
      m.moderation_live_lift_prompt({
        name: broadcasterName || m.moderation_live_withdraw_this_account(),
      }),
      { confirmLabel: m.moderation_live_lift_button() }
    );
    if (!yes) {
      console.debug(`[MODERATION] lift of ${userId}'s withdrawal declined`);
      lifting = false;
      return;
    }
    liftError = '';
    console.debug(`[MODERATION] lifting the withdrawal of ${userId}`);
    try {
      const result = await liftBroadcasterWithdrawal(userId);
      console.log(
        `[MODERATION] withdrawal of ${userId} ${result.lifted ? 'lifted' : 'was not there'}`
      );
      onLifted(result);
    } catch (e) {
      // A refusal is an answer (the server said no); no answer at all is a transport failure.
      console.warn(
        `[MODERATION] lifting the withdrawal of ${userId} failed${isTransportFailure(e) ? ' (no answer)' : ''}`,
        e
      );
      liftError = liftErrorText(e);
    } finally {
      lifting = false;
    }
  }

  function handleWithdrawn(result: LiveWithdrawalResult) {
    console.log(
      `[MODERATION] right of ${result.userId} withdrawn (${result.newlyWithdrawn ? 'new' : 'repeat'})`
    );
    withdrawOpen = false;
    onWithdrawn(result);
  }

  function handleCut(result: LiveCutResult) {
    console.log(`[MODERATION] live ${liveId}: cut recorded, ${result.priorCuts} prior`);
    dialogOpen = false;
    onCut(result);
  }
</script>

<div
  class="mb-3 space-y-1.5 rounded-lg bg-black/5 px-3 py-2 text-xs"
  data-moderation-live={live.state}
>
  <div class="flex flex-wrap items-center gap-2">
    <span
      class="text-2xs rounded-full px-2 py-0.5 font-bold {live.state === 'open'
        ? 'bg-red-500 text-white'
        : 'bg-cn-border/40 text-text-muted'}"
      data-moderation-live-state
    >
      {stateLabel[live.state]}
    </span>
    {#if broadcasterName}
      <span class="text-text-main font-medium"
        >{m.moderation_live_broadcaster_label({ name: broadcasterName })}</span
      >
    {/if}
  </div>
  {#if live.startedAt}
    <p class="text-text-muted">
      {m.moderation_live_started_label({ date: formatDate(live.startedAt) })}
    </p>
  {/if}
  {#if live.endedAt}
    <p class="text-text-muted">
      {m.moderation_live_ended_label({ date: formatDate(live.endedAt) })}
    </p>
  {/if}
  {#if live.cutReason}
    <p class="text-text-muted" data-moderation-live-cut-reason>
      {m.moderation_live_cut_reason_label({ reason: reasonLabel(live.cutReason) })}
    </p>
  {/if}
  {#if live.broadcasterCuts > 0}
    <p class="text-red-err font-semibold" data-moderation-live-prior>
      {m.moderation_live_prior_cuts({ count: live.broadcasterCuts })}
    </p>
  {/if}
  {#if live.state === 'gone'}
    <p class="text-text-muted italic">{m.moderation_live_gone_hint()}</p>
  {/if}
  {#if standing}
    <div class="border-cn-border space-y-1 border-t pt-1.5" data-moderation-live-standing>
      <p class="text-text-main flex items-center gap-1.5 font-semibold">
        <ShieldAlert size={13} />
        {m.moderation_live_standing_title()}
      </p>
      <p class="text-text-muted" data-moderation-live-standing-cuts>
        {m.moderation_live_standing_cuts({
          count: standing.cutsOnRecord,
          required: LIVE_WITHDRAWAL_FROM_CUTS,
          days: LIVE_STRIKE_WINDOW_DAYS,
        })}
      </p>
      {#if standing.withdrawnAt}
        <p class="text-red-err font-semibold" data-moderation-live-withdrawn>
          {m.moderation_live_standing_withdrawn({ date: formatDate(standing.withdrawnAt) })}
        </p>
      {:else if standing.suspendedUntil}
        <p class="text-red-err font-semibold" data-moderation-live-suspended>
          {m.moderation_live_standing_suspended({ date: formatDate(standing.suspendedUntil) })}
        </p>
      {:else if standing.cutsOnRecord === 0}
        <p class="text-text-muted">{m.moderation_live_standing_clean()}</p>
      {/if}
      {#if standing.withdrawalDue}
        <p class="text-accent-text font-semibold" data-moderation-live-due>
          {m.moderation_live_standing_due()}
        </p>
      {/if}
    </div>
  {/if}
  <div class="flex flex-wrap items-center gap-2 pt-1">
    <button
      type="button"
      onclick={() => void copyId(liveId)}
      class="text-text-muted/50 hover:text-text-muted text-2xs flex items-center gap-1 font-mono transition-colors"
      title={m.admin_copy_id_label()}
      data-moderation-live-id
    >
      {liveId}
      <Copy size={10} />
    </button>
    {#if withdrawable}
      <button
        type="button"
        onclick={() => (withdrawOpen = true)}
        class="border-cn-border text-text-muted flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors hover:border-red-400 hover:text-red-600"
        data-moderation-live-withdraw
      >
        <Ban size={13} />
        {m.moderation_live_withdraw_button()}
      </button>
    {/if}
    {#if liftable}
      <Button
        variant="secondary"
        size="compact"
        onclick={() => void lift()}
        loading={lifting}
        data-moderation-live-lift
      >
        <RotateCcw size={13} />
        {m.moderation_live_lift_button()}
      </Button>
    {/if}
    {#if cuttable}
      <button
        type="button"
        onclick={() => (dialogOpen = true)}
        class="border-cn-border text-text-muted ml-auto flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors hover:border-red-400 hover:text-red-600"
        data-moderation-live-cut
      >
        <Scissors size={13} />
        {m.moderation_live_cut_button()}
      </button>
    {/if}
  </div>
  {#if liftError}
    <p class="text-red-err" role="alert" data-moderation-live-lift-error>{liftError}</p>
  {/if}
</div>

{#if withdrawable && live.broadcasterId}
  <ModerationLiveWithdrawDialog
    open={withdrawOpen}
    userId={live.broadcasterId}
    {broadcasterName}
    onWithdrawn={handleWithdrawn}
    {onStale}
    onClose={() => (withdrawOpen = false)}
  />
{/if}

{#if cuttable}
  <ModerationLiveCutDialog
    open={dialogOpen}
    {liveId}
    {broadcasterName}
    priorCuts={live.broadcasterCuts}
    onCut={handleCut}
    onClose={() => (dialogOpen = false)}
  />
{/if}
