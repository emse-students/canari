<script lang="ts">
  import { Copy, Scissors } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { copyId } from '$lib/utils/copyId';
  import type { ReportedLive } from '$lib/moderation/api';
  import { liveStateLabels } from '$lib/moderation/liveState';
  import type { LiveCutResult } from '$lib/live/types';
  import ModerationLiveCutDialog from './ModerationLiveCutDialog.svelte';

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
  }

  let { liveId, live, formatDate, reasonLabel, onCut }: Props = $props();

  let dialogOpen = $state(false);

  const stateLabel = $derived(liveStateLabels());

  /** Only a live that still has a row can be cut: `open`, or `ended` and not yet purged. */
  const cuttable = $derived(live.state === 'open' || live.state === 'ended');
  const broadcasterName = $derived(live.broadcasterName ?? '');

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
</div>

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
