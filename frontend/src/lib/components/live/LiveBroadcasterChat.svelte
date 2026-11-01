<script lang="ts">
  /**
   * THE BROADCASTER'S VIEW OF ITS LIVE'S CHAT (WP-L6): the same panel and floating reactions a viewer
   * sees, with a HIDE button on every line (C14), fed by the broadcaster's ONE chat loop
   * (`LiveBroadcasterChatPoller` - a broadcaster plays nothing, so no player polls for it).
   *
   * Mounted by the broadcaster screen (`LiveBroadcaster.svelte`) while on air, with the live's id
   * and key. Every verdict that the live is over - the loop's, or one answering the broadcaster's own
   * write - goes to `onEnded`, which hands it to the broadcast machine. The viewer count rides the
   * same loop and goes to `onViewers`. It fills the positioned box it is placed in.
   */
  import { onMount } from 'svelte';
  import LiveChatPanel from './LiveChatPanel.svelte';
  import LiveReactionsLayer from './LiveReactionsLayer.svelte';
  import { fetchLiveLimits, type LiveRefusalError } from '$lib/live/api';
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
    /** Told when the server says the live is over, with its verdict (`endReason` in the body). */
    onEnded?: (verdict: LiveRefusalError) => void;
    /**
     * Told the live's viewer count at each poll of this loop, `null` on a failed poll and when this
     * component goes (off air, or a new live): none to show, never a stale or another live's number.
     */
    onViewers?: (count: number | null) => void;
    /** Whether the lines and composer are drawn; the poll (and the viewer count) goes on when not. */
    visible?: boolean;
    /** Replace the outside world - for tests. */
    chatDeps?: Partial<LiveChatDeps>;
    pollerDeps?: Partial<LiveBroadcasterChatPollerDeps>;
    fetchLimits?: typeof fetchLiveLimits;
  }

  let {
    liveId,
    keyHex,
    onEnded,
    onViewers,
    visible = true,
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
      onLiveOver: (verdict) => onEnded?.(verdict),
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
    const poller = new LiveBroadcasterChatPoller(
      liveId,
      s,
      pollerDeps,
      (verdict) => {
        ended = true;
        onEnded?.(verdict);
      },
      (count) => onViewers?.(count)
    );
    poller.start();
    return () => {
      poller.stop();
      s.stop();
      session = null;
      // The count was THIS live's while on air: off air, or remounted for a new live (the screen
      // keys this component on the live id), the screen must not keep it.
      onViewers?.(null);
    };
  });

  function send(text: string): Promise<LiveChatSendFailure | null> {
    if (!session) return Promise.resolve('refused');
    return session.send(text);
  }
</script>

<div class="pointer-events-none absolute inset-0 flex items-end p-3" data-live-broadcaster-chat>
  <LiveReactionsLayer bind:this={reactions} />
  {#if visible}
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
  {/if}
</div>
