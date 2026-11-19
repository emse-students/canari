<script lang="ts">
  import { UserCheck } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import type { LiveBroadcasterStanding, LiveWithdrawalLift } from '$lib/live/types';
  import { LIVE_STRIKE_WINDOW_DAYS, LIVE_WITHDRAWAL_FROM_CUTS } from '$lib/live/constants';
  import LiftWithdrawalButton from './LiftWithdrawalButton.svelte';

  /**
   * THE WITHDRAWN BROADCASTERS of `/admin/moderation`: the accounts whose right to broadcast staff
   * withdrew, each with the lift. It reads `live_broadcast_withdrawals`, never a report, so a
   * withdrawal stays reachable once every report naming the member is handled (principle 6: a
   * sanction is reversible by the people who gave it). The server already narrowed the rows to the
   * people the caller may act on.
   */
  interface Props {
    rows: LiveBroadcasterStanding[];
    loading: boolean;
    /** Formats an ISO instant in the reader's locale (the page's one formatter). */
    formatDate: (iso: string) => string;
    /** Resolves a report-reason code to its label. */
    reasonLabel: (code: string) => string;
    /** Told after a lift so the page reads the list again. */
    onLifted: (result: LiveWithdrawalLift) => void;
  }

  let { rows, loading, formatDate, reasonLabel, onLifted }: Props = $props();
</script>

{#if loading}
  <div class="space-y-3">
    {#each { length: 2 } as _, i (i)}
      <div
        data-loading-skeleton
        class="border-cn-border bg-cn-surface animate-pulse space-y-2 rounded-2xl border p-5"
      >
        <div class="bg-cn-border/60 h-3 w-2/3 rounded"></div>
      </div>
    {/each}
  </div>
{:else if rows.length === 0}
  <div class="text-text-muted py-16 text-center" data-moderation-withdrawn-empty>
    <UserCheck size={40} class="mx-auto mb-3 opacity-30" />
    <p class="font-medium">{m.moderation_withdrawn_empty()}</p>
  </div>
{:else}
  <div class="space-y-3">
    {#each rows as row (row.userId)}
      <div
        class="border-cn-border bg-cn-surface flex items-start gap-3 rounded-2xl border p-4 shadow-sm"
        data-moderation-withdrawn-row={row.userId}
      >
        <div class="mt-0.5 shrink-0"><Avatar userId={row.userId} size="sm" /></div>
        <div class="min-w-0 flex-1 space-y-0.5">
          <p class="text-text-main text-sm font-medium">{row.displayName}</p>
          <p class="text-text-muted/50 text-2xs font-mono">{row.userId.slice(0, 16)}…</p>
          {#if row.withdrawnAt}
            <p class="text-red-err text-xs font-semibold">
              {m.moderation_live_standing_withdrawn({ date: formatDate(row.withdrawnAt) })}
            </p>
          {/if}
          {#if row.withdrawalReason}
            <p class="text-text-muted text-xs" data-moderation-withdrawn-reason>
              {m.moderation_withdrawn_reason({ reason: reasonLabel(row.withdrawalReason) })}
            </p>
          {/if}
          <p class="text-text-muted text-xs">
            {m.moderation_live_standing_cuts({
              count: row.cutsOnRecord,
              required: LIVE_WITHDRAWAL_FROM_CUTS,
              days: LIVE_STRIKE_WINDOW_DAYS,
            })}
          </p>
        </div>
        <div class="flex shrink-0 flex-wrap items-center gap-2">
          <LiftWithdrawalButton userId={row.userId} name={row.displayName} {onLifted} />
        </div>
      </div>
    {/each}
  </div>
{/if}
