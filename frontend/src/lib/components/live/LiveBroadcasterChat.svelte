<script lang="ts">
  /**
   * THE BROADCASTER'S VIEW OF ITS LIVE'S CHAT (WP-L6): the same panel and floating reactions a viewer
   * sees, with a HIDE button on every line (C14), fed by the broadcaster's ONE chat loop
   * (`LiveBroadcasterChatPoller` - a broadcaster plays nothing, so no player polls for it).
   *
   * A HOOK for the broadcaster screen of WP-L5's broadcaster half (#2115, not merged when this was
   * written): it mounts with the live's id and key, and needs nothing else from that screen. Place
   * it inside a positioned box over the preview; it fills that box.
   */
  import { onMount } from 'svelte';
  import LiveChatPanel from './LiveChatPanel.svelte';
  import LiveReactionsLayer from './LiveReactionsLayer.svelte';
  import { fetchLiveLimits } from '$lib/live/api';
  import {
    LiveBroadcasterChatPoller,
    LiveChatSession,
    type LiveBroadcasterChatPollerDeps,
    type LiveChatDeps,
    type LiveChatLine,
    type LiveChatSendFailure,
  } from '$lib/live/liveChat';
  import { currentUserId } from '$lib/stores/userState.svelte';

  interface Props {
    liveId: string;
    /** The live key the broadcaster generated - never logged. */
    keyHex: string;
    /** Told once when the server says the live is over. */
    onEnded?: () => void;
    /** Replace the outside world - for tests. */
    chatDeps?: Partial<LiveChatDeps>;
    pollerDeps?: Partial<LiveBroadcasterChatPollerDeps>;
    fetchLimits?: typeof fetchLiveLimits;
  }

  let {
    liveId,
    keyHex,
    onEnded,
    chatDeps,
    pollerDeps,
    fetchLimits = fetchLiveLimits,
  }: Props = $props();

  let lines = $state<readonly LiveChatLine[]>([]);
  let maxChars = $state<number | null>(null);
  // The account is read reactively: one that loads after mount enables the composer then.
  let ended = $state(false);
  const canWrite = $derived(!ended && currentUserId() !== null);
  let reactions = $state<LiveReactionsLayer | null>(null);
  let session: LiveChatSession | null = null;

  onMount(() => {
    console.debug(`[LIVE_CHAT] broadcaster chat opened on ${liveId}`);
    const s = new LiveChatSession({
      liveId,
      me: currentUserId,
      onChange: (next) => {
        lines = next;
      },
      onFloat: (kind, count) => reactions?.add(kind, count),
      deps: chatDeps,
    });
    s.setKey(keyHex);
    session = s;
    fetchLimits().then(
      (limits) => {
        s.setLimits(limits);
        maxChars = s.messageMaxChars;
      },
      (e: unknown) => {
        console.warn(`[LIVE_CHAT] the live limits could not be read (${String(e)})`);
      }
    );
    const poller = new LiveBroadcasterChatPoller(liveId, s, pollerDeps, () => {
      ended = true;
      onEnded?.();
    });
    poller.start();
    return () => {
      poller.stop();
      s.stop();
      session = null;
    };
  });

  function send(text: string): Promise<LiveChatSendFailure | null> {
    if (!session) return Promise.resolve('refused');
    return session.send(text);
  }
</script>

<div class="pointer-events-none absolute inset-0 flex items-end p-3" data-live-broadcaster-chat>
  <LiveReactionsLayer bind:this={reactions} />
  <LiveChatPanel
    {lines}
    {canWrite}
    {maxChars}
    canModerate
    {send}
    retry={(id) => void session?.retry(id)}
    discard={(id) => session?.discard(id)}
    hide={(id) => void session?.hide(id)}
  />
</div>
