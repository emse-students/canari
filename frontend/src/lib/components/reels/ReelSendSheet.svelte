<script lang="ts">
  /**
   * "ENVOYER A..." - the camera tab's send sheet (reels-in-chat RC-12, 15.1, 15.8), over the take's
   * review. FIRST ROW "Publier sur CanaReels" (Snapchat's "My Story"), then the member's DMs and
   * groups in the conversation list's own order, a local search, a checkbox per row, the ticked
   * targets as chips and "Envoyer (N)" in the footer.
   *
   * IT IS A HISTORY ENTRY ABOVE THE TAKE'S, so Android's Back (and iOS's edge swipe) returns to the
   * review. The sheet decides nothing about the send: `onsend` hands the ticks to `ReelCapture`,
   * which writes ONE take and N sends (`sendChatReelTakeTo`) and/or opens the publish step.
   *
   * THE LIST IS A COURTESY, THE SERVER THE AUTHORITY (`reelSendTargets.ts`): salons are not listed
   * (RC-8), and the cap on chat targets is the server's `chatReelMaxTargets` carried in as `cap` -
   * a tick past it is REFUSED WITH A SENTENCE, never silently.
   */
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import { Check, ChevronLeft, Film, Search, X } from '@lucide/svelte';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import GroupAvatar from '$lib/components/shared/GroupAvatar.svelte';
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { cachedMuteStatus, getMuteStatus } from '$lib/moderation/muteCheck';
  import { listBlockedUsers } from '$lib/users/blocks';
  import { missingPeerNameIds } from '$lib/sharing/shareDestinations';
  import { resolveUserDisplayName } from '$lib/utils/users/displayName';
  import { reelSendCandidates, toggleReelTarget } from '$lib/reels/reelSendTargets';
  import type { ReelSendHost } from '$lib/reels/reelSendBridge';
  import { bindHistoryOverlay } from '$lib/utils/bindHistoryOverlay.svelte';
  import type { ReelClip } from '$lib/reels/reelCapture';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    clip: ReelClip;
    /** The messaging layer: the conversations listed and the account (`reelSendBridge`). */
    host: Pick<ReelSendHost, 'conversations' | 'userId'>;
    /** The most conversations one take may be sent to (`chatReelTargetCap`): the server's, never a guess. */
    cap: number;
    /** The longest take a conversation accepts (`chatMaxDurationMs`): a longer one can only be posted. */
    chatCapMs: number;
    /** Back to the take. */
    onclose: () => void;
    /** The press: whether CanaReels is ticked, and the conversation keys, in tick order. */
    onsend: (choice: { feed: boolean; targetKeys: string[] }) => void;
    /** A press is being written: "Envoyer" waits, so one take can never be queued twice. */
    sending?: boolean;
  }

  let { clip, host, cap, chatCapMs, onclose, onsend, sending = false }: Props = $props();

  let query = $state('');
  let feedTicked = $state(false);
  let selected = $state<string[]>([]);
  let capNotice = $state(false);
  let peerNames = $state<Record<string, string>>({});
  let blockedPeerIds = $state<ReadonlySet<string>>(new Set());
  /**
   * Whether the blocked list was ANSWERED. A block does not refuse a DM message server-side
   * (moderation-and-blocking.md: a failure to ask is not an answer), so until it is read - and for
   * good if the read fails - the chat rows stay disabled rather than listing a blocked person.
   */
  let blocksState = $state<'pending' | 'read' | 'failed'>('pending');
  /** `null` until asked: the feed row is not offered as muted on a guess. */
  let muted = $state<boolean | null>(cachedMuteStatus()?.isMuted ?? null);
  let heading = $state<HTMLElement | null>(null);

  /** A silenced take cannot reach a chat: the audio track is dropped only by the feed's publish. */
  const silenced = $derived(clip.soundRemoved === true);
  const tooLong = $derived(clip.durationMs !== undefined && clip.durationMs > chatCapMs);
  const chatsBlocked = $derived(silenced || tooLong || blocksState !== 'read');
  const feedMuted = $derived(muted === true);
  /** The feed row waits for the mute answer; a tick made before it never survives (`feedSend`). */
  const feedUnknown = $derived(muted === null);
  const feedSend = $derived(feedTicked && muted === false);

  const overlay = bindHistoryOverlay(
    () => true,
    () => onclose()
  );

  $effect(() => {
    for (const id of missingPeerNameIds(host.conversations(), host.userId())) {
      void resolveUserDisplayName(id).then((name) => {
        if (name) peerNames = { ...peerNames, [id]: name };
      });
    }
  });

  const candidates = $derived(
    reelSendCandidates({
      conversations: host.conversations(),
      currentUserId: host.userId(),
      peerNames,
      query,
      blockedPeerIds,
    })
  );
  /** Every conversation the sheet lists, whatever the search says: what a tick must still belong to. */
  const listedKeys = $derived(
    new Set(
      reelSendCandidates({
        conversations: host.conversations(),
        currentUserId: host.userId(),
        peerNames,
        query: '',
        blockedPeerIds,
      }).map((c) => c.key)
    )
  );
  /** THE SEND SET IS selected AND currently listed: a tick on a row that is no longer one is dropped. */
  const sendKeys = $derived(chatsBlocked ? [] : selected.filter((k) => listedKeys.has(k)));
  const count = $derived(sendKeys.length + (feedSend ? 1 : 0));
  const labelOf = (key: string) =>
    candidates.find((c) => c.key === key)?.label ??
    [...host.conversations()].find(([k]) => k === key)?.[1].name ??
    key;

  onMount(() => {
    overlay.syncOpen();
    heading?.focus();
    // THE MUTE AND THE BLOCKS ARE ASKED ONCE, WHEN THE SHEET OPENS (15.8); the server answers again
    // at the publish and at each send. A failed read lists everything: the server is the authority.
    void getMuteStatus().then(
      (s) => (muted = s.isMuted),
      // The publish step asks the mute again before anything is uploaded, so a failed read here
      // leaves the feed row open: that ask is the answer.
      (e: unknown) => {
        console.warn(
          '[reel-send] the mute status could not be read - the publish step asks again',
          e
        );
        muted = false;
      }
    );
    void listBlockedUsers().then(
      (rows) => {
        blockedPeerIds = new Set(rows.map((r) => r.userId));
        blocksState = 'read';
      },
      (e: unknown) => {
        console.error(
          '[reel-send] the blocked list could not be read: the chat rows stay disabled',
          e
        );
        blocksState = 'failed';
      }
    );
  });

  function toggleFeed() {
    if (feedMuted || feedUnknown) return;
    feedTicked = !feedTicked;
    capNotice = false;
  }

  function toggleTarget(key: string) {
    if (chatsBlocked) return;
    const next = toggleReelTarget(selected, key, cap);
    selected = next.selected;
    capNotice = next.capped;
    if (next.capped) console.debug(`[reel-send] tick refused: ${cap} conversations at most`);
  }

  function send() {
    if (count === 0 || sending) return;
    console.debug(`[reel-send] press: feed=${feedSend}, ${sendKeys.length} conversation(s)`);
    onsend({ feed: feedSend, targetKeys: [...sendKeys] });
  }

  const ROW =
    'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left outline-none focus-visible:bg-black/5 dark:focus-visible:bg-white/10 enabled:hover:bg-black/5 dark:enabled:hover:bg-white/5 disabled:opacity-50';
</script>

<div
  class="bg-cn-bg text-text-main absolute inset-0 z-20 flex flex-col"
  in:fade={{ duration: 150 }}
  data-reel-send
>
  <header
    class="border-cn-border bg-cn-surface flex shrink-0 items-center gap-2 border-b px-2 pt-[calc(var(--safe-area-inset-top,0px)+0.5rem)] pb-2"
  >
    <button
      type="button"
      class="ui-icon-button"
      aria-label={m.reel_sendto_back()}
      title={m.reel_sendto_back()}
      onclick={() => overlay.dismissFromUi()}
    >
      <ChevronLeft size={24} strokeWidth={2.5} />
    </button>
    <h1 bind:this={heading} tabindex="-1" class="text-base font-bold outline-none">
      {m.reel_sendto_title()}
    </h1>
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pt-3 pb-3">
    <button
      type="button"
      role="checkbox"
      aria-checked={feedSend}
      disabled={feedMuted || feedUnknown}
      class={ROW}
      onclick={toggleFeed}
      data-reel-send-feed
    >
      <span
        class="bg-accent/20 text-text-main flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
      >
        <Film size={20} strokeWidth={2.25} />
      </span>
      <span class="min-w-0 flex-1 text-sm font-semibold">{m.reel_sendto_feed_row()}</span>
      {@render tick(feedSend)}
    </button>
    {#if feedMuted}
      <p class="text-text-muted text-2xs px-3 pb-1" role="note" data-reel-send-muted>
        {m.reel_sendto_feed_muted()}
      </p>
    {/if}

    <div class="relative my-2">
      <Search size={16} class="text-text-muted absolute top-1/2 left-3 -translate-y-1/2" />
      <input
        type="search"
        bind:value={query}
        placeholder={m.reel_sendto_search()}
        aria-label={m.reel_sendto_search()}
        class="border-cn-border text-text-main focus:border-accent-icon w-full rounded-lg border bg-(--cn-surface) py-2.5 pr-3 pl-9 text-sm outline-none"
        data-reel-send-search
      />
    </div>

    {#if blocksState === 'failed'}
      <p class="text-text-muted text-2xs px-3 pb-2" role="note" data-reel-send-blocks-unread>
        {m.reel_sendto_blocks_unread()}
      </p>
    {:else if silenced}
      <p class="text-text-muted text-2xs px-3 pb-2" role="note" data-reel-send-silent>
        {m.reel_sendto_sound_removed_chats()}
      </p>
    {:else if tooLong}
      <p class="text-text-muted text-2xs px-3 pb-2" role="note" data-reel-send-too-long>
        {m.reel_sendto_too_long_for_chats({ seconds: Math.round(chatCapMs / 1000) })}
      </p>
    {/if}

    {#if candidates.length === 0}
      <p class="text-text-muted py-8 text-center text-sm" data-reel-send-empty>
        {query.trim() ? m.reel_sendto_no_match() : m.reel_sendto_empty()}
      </p>
    {:else}
      <ul class="flex flex-col gap-0.5">
        {#each candidates as cand (cand.key)}
          {@const ticked = selected.includes(cand.key)}
          <li>
            <button
              type="button"
              role="checkbox"
              aria-checked={ticked}
              aria-label={m.reel_sendto_row_label({
                name: cand.label,
                kind:
                  cand.conversation.conversationType === 'direct'
                    ? m.reel_sendto_kind_direct()
                    : m.reel_sendto_kind_group(),
              })}
              disabled={chatsBlocked}
              class={ROW}
              onclick={() => toggleTarget(cand.key)}
              data-reel-send-row={cand.key}
            >
              <span class="h-10 w-10 shrink-0">
                {#if cand.conversation.conversationType === 'direct'}
                  <Avatar
                    userId={cand.conversation.directPeerId ?? cand.conversation.contactName}
                    fill
                    fallbackLabel={cand.label}
                  />
                {:else}
                  <GroupAvatar
                    id={cand.conversation.id}
                    imageMediaId={cand.conversation.imageMediaId}
                    name={cand.label}
                    fill
                  />
                {/if}
              </span>
              <span class="min-w-0 flex-1 truncate text-sm">
                <EmojiText text={cand.label} />
              </span>
              {@render tick(ticked)}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <div
    class="border-cn-border bg-cn-surface shrink-0 border-t px-3 pt-2 pb-[calc(var(--safe-area-inset-bottom,0px)+0.5rem)]"
  >
    {#if capNotice}
      <p role="alert" class="text-amber-warn-text mb-2 text-sm font-semibold" data-reel-send-cap>
        {m.reel_sendto_cap({ count: cap })}
      </p>
    {/if}
    {#if feedSend && sendKeys.length > 0}
      <!-- ONE FILE FOR THE FEED AND THE CHATS (15.5, D-onefile): the conversations receive the
           published video itself, under the post's key - said, never claimed end-to-end. -->
      <p class="text-text-muted text-2xs mb-2" role="note" data-reel-send-same-as-post>
        {m.reel_sendto_same_as_post()}
      </p>
    {/if}
    {#if sendKeys.length > 0}
      <ul class="mb-2 flex gap-2 overflow-x-auto" data-reel-send-chips>
        {#each sendKeys as key (key)}
          <li class="shrink-0">
            <button
              type="button"
              class="bg-cn-bg border-cn-border text-text-main flex items-center gap-1 rounded-full border py-1 pr-2 pl-3 text-xs"
              aria-label={m.reel_sendto_chip_remove({ name: labelOf(key) })}
              onclick={() => toggleTarget(key)}
            >
              <span class="max-w-32 truncate"><EmojiText text={labelOf(key)} /></span>
              <X size={14} strokeWidth={2.5} />
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    <div class="flex justify-end">
      <Button
        type="button"
        class="shrink-0"
        disabled={count === 0 || sending}
        onclick={send}
        data-reel-send-submit
      >
        {m.reel_sendto_send({ count })}
      </Button>
    </div>
  </div>
</div>

{#snippet tick(on: boolean)}
  <span
    class={[
      'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2',
      on ? 'border-accent-icon bg-accent text-on-accent' : 'border-cn-border',
    ]}
    aria-hidden="true"
  >
    {#if on}<Check size={14} strokeWidth={3} />{/if}
  </span>
{/snippet}
