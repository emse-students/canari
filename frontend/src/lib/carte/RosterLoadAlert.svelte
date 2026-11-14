<script lang="ts">
  /**
   * The carte editor's alert for what it could not load: each association whose roster failed, with
   * a retry of its own, and the count of shown associations the catalogue did not list. A roster
   * that failed is NOT an empty one - this alert is how the author learns the difference, and why
   * publishing and exporting are refused until it is gone ($lib/carte/rosterLoads).
   */
  import { TriangleAlert, RefreshCw } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /**
     * The drawn associations whose roster is not loaded; `loading` while a retry runs, `stale` when
     * the server said the roster changed since the editor read it.
     */
    missing: { id: string; name: string; loading: boolean; stale: boolean }[];
    /** How many shown associations the editor could not read at all (a reload is the cure). */
    unlisted: number;
    /** Re-reads one association's roster. */
    onRetry: (associationId: string) => void;
  }

  let { missing, unlisted, onRetry }: Props = $props();
</script>

<div
  class="border-cn-border bg-cn-surface-alt m-3 flex shrink-0 items-start gap-3 rounded-2xl border p-3"
  role="alert"
  data-roster-load-alert
>
  <TriangleAlert size={18} class="text-accent-icon mt-0.5 shrink-0" />
  <div class="min-w-0 flex-1">
    <p class="text-text-main text-sm font-bold">{m.carte_roster_failed_title()}</p>
    <p class="text-text-muted mt-0.5 text-sm">{m.carte_roster_failed_body()}</p>
    {#if missing.length > 0}
      <ul class="mt-2 flex flex-col gap-1.5">
        {#each missing as asso (asso.id)}
          <li class="flex items-center gap-2" data-roster-failed={asso.id}>
            <span class="text-text-main min-w-0 flex-1 truncate text-sm">
              {asso.name}
              {#if asso.stale}
                <span class="text-text-muted text-xs">- {m.carte_roster_stale()}</span>
              {/if}
            </span>
            <Button
              size="compact"
              variant="secondary"
              loading={asso.loading}
              disabled={asso.loading}
              onclick={() => onRetry(asso.id)}
            >
              <RefreshCw size={14} />
              {m.common_retry_button()}
            </Button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if unlisted > 0}
      <p class="text-text-muted mt-2 text-sm">{m.carte_roster_unlisted({ count: unlisted })}</p>
    {/if}
  </div>
</div>
