<script lang="ts">
  /**
   * THE PAGE OF ONE LIVE, `/lives/<id>`: the link a live is shared by (the Share button of both live
   * screens) and the target of the "X est en live" push. It opens the full-screen viewer on a live
   * that is running, and says so in words - never a raw error - when it is not: over (or not
   * visible to this reader, which the server answers identically on purpose), full, removed, or
   * switched off. Visibility and auth are the SERVER's (`assertMayWatch`, behind `GET /api/lives/:id`);
   * this page only reads the refusal's type (`liveRouteProblemOf`).
   *
   * Closing the viewer, or the "back to the feed" button, leaves for the feed with a replace: a
   * finished live is not a page to come back to.
   */
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { LoaderCircle, Radio } from '@lucide/svelte';
  import LiveViewer from '$lib/components/live/LiveViewer.svelte';
  import { fetchLive } from '$lib/live/api';
  import { liveRouteProblemOf, type LiveRouteProblem } from '$lib/live/liveRoute';
  import type { LiveListItem } from '$lib/live/types';
  import { serverLivesMode } from '$lib/stores/appVersionCheck.svelte';
  import { livesAvailable } from '$lib/utils/livesAvailability';
  import { m } from '$lib/paraglide/messages';

  type Screen = { kind: 'loading' } | { kind: 'ready'; live: LiveListItem } | LiveProblemScreen;
  type LiveProblemScreen = { kind: 'problem'; problem: LiveRouteProblem };

  const liveId = $derived(page.params.liveId ?? '');
  let screen = $state<Screen>({ kind: 'loading' });
  /** Bumped by the retry button: the read is keyed on it as well as on the id. */
  let attempt = $state(0);

  $effect(() => {
    const id = liveId;
    void attempt;
    if (!id) return;
    let current = true;
    screen = { kind: 'loading' };
    if (!livesAvailable(serverLivesMode())) {
      console.debug('[LIVE] the live page was opened while lives are off');
      screen = { kind: 'problem', problem: 'unavailable' };
      return;
    }
    console.debug(`[LIVE] the live page opens ${id}`);
    fetchLive(id).then(
      (view) => {
        if (!current) return;
        screen = {
          kind: 'ready',
          live: {
            id: view.id,
            broadcasterId: view.broadcasterId,
            associationId: view.associationId,
            startedAt: view.startedAt,
          },
        };
      },
      (e: unknown) => {
        if (!current) return;
        const problem = liveRouteProblemOf(e);
        console.warn(`[LIVE] the live page cannot open ${id}: ${problem} (${String(e)})`);
        screen = { kind: 'problem', problem };
      }
    );
    return () => {
      current = false;
    };
  });

  function leave() {
    console.debug('[LIVE] the live page leaves for the feed');
    void goto(resolve('/posts'), { replaceState: true });
  }
</script>

{#if screen.kind === 'ready'}
  <LiveViewer live={screen.live} onClose={leave} />
{:else}
  <main
    class="flex min-h-dvh flex-col items-center justify-center gap-3 bg-black px-8 text-center text-white"
    data-live-route={screen.kind === 'problem' ? screen.problem : 'loading'}
  >
    {#if screen.kind === 'loading'}
      <LoaderCircle size={32} class="motion-safe:animate-spin" aria-hidden="true" />
      <p class="text-sm" role="status">{m.live_viewer_connecting()}</p>
    {:else}
      <Radio size={40} class="opacity-80" aria-hidden="true" />
      {#if screen.problem === 'gone'}
        <h1 class="text-lg font-bold">{m.live_route_gone_title()}</h1>
        <p class="max-w-sm text-sm opacity-90">{m.live_route_gone_body()}</p>
      {:else if screen.problem === 'full'}
        <h1 class="text-lg font-bold">{m.live_viewer_full_title()}</h1>
        <p class="max-w-sm text-sm opacity-90">{m.live_viewer_full_body()}</p>
      {:else if screen.problem === 'retry'}
        <h1 class="text-lg font-bold">{m.live_viewer_unavailable_title()}</h1>
        <p class="max-w-sm text-sm opacity-90">{m.live_route_retry_body()}</p>
      {:else}
        <h1 class="text-lg font-bold">{m.live_viewer_unavailable_title()}</h1>
        <p class="max-w-sm text-sm opacity-90">{m.live_viewer_unavailable_body()}</p>
      {/if}
      {#if screen.problem === 'full' || screen.problem === 'retry'}
        <button
          type="button"
          class="bg-cn-yellow text-cn-ink mt-2 min-h-11 rounded-full px-5 text-sm font-bold outline-none focus-visible:ring-2 focus-visible:ring-white"
          onclick={() => attempt++}
          data-live-route-retry
        >
          {m.common_retry_button()}
        </button>
      {/if}
      <button
        type="button"
        class="min-h-11 rounded-full bg-white/15 px-5 text-sm font-bold outline-none hover:bg-white/25 focus-visible:ring-2 focus-visible:ring-white"
        onclick={leave}
        data-live-route-back
      >
        {m.live_viewer_back()}
      </button>
    {/if}
  </main>
{/if}
