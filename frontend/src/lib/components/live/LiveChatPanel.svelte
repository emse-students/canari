<script lang="ts">
  /**
   * THE LIVE CHAT, DRAWN (WP-L6): the lines over the bottom of the video and, for a viewer who may
   * write, the composer under them. Presentational - every decision is `LiveChatSession`
   * (`$lib/live/liveChat.ts`); this file draws its lines and calls back.
   *
   * Plain text only (C15): a line is a text node with its emoji drawn as Noto SVG (`EmojiText`),
   * never markup, never a link. The list is a `log` live region, so a screen reader reads new lines
   * politely. `canModerate` (the broadcaster, or staff) adds a hide button to every line not one's
   * own (C14); `report` (a viewer) adds a flag to every line not one's own; hiding one's own line is the same route, offered too.
   */
  import { untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { ArrowDown, EyeOff, Flag, RotateCcw, SendHorizontal, Trash2 } from '@lucide/svelte';
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import { isAtBottom, onLinesAdded } from '$lib/live/chatScroll';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import type { LiveChatLine, LiveChatSendFailure } from '$lib/live/liveChat';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    lines: readonly LiveChatLine[];
    /** Whether the composer is shown: the key is held and the account known. */
    canWrite: boolean;
    /** The server's longest message, or null before the limits arrived. */
    maxChars: number | null;
    /** The broadcaster or staff: every line gets a hide button. */
    canModerate?: boolean;
    send(text: string): Promise<LiveChatSendFailure | null>;
    retry(clientId: string): void;
    discard(clientId: string): void;
    hide(messageId: string): void;
    /** Report one line of someone else's (a viewer's flag); absent where reporting is not offered. */
    report?(line: LiveChatLine): void;
  }

  let {
    lines,
    canWrite,
    maxChars,
    canModerate = false,
    send,
    retry,
    discard,
    hide,
    report,
  }: Props = $props();

  let draft = $state('');
  let composerError = $state<string | null>(null);
  let list = $state<HTMLOListElement | null>(null);
  /** Authors whose name was asked for once - the cache is reactive and fills the lines itself. */
  const asked = new SvelteSet<string>();

  $effect(() => {
    const authors = lines.map((l) => l.authorId);
    untrack(() => {
      for (const id of authors) {
        if (asked.has(id)) continue;
        asked.add(id);
        resolveUserDisplayName(id).catch((e: unknown) => {
          console.warn(`[LIVE_CHAT] the name of ${id} could not be read (${String(e)})`);
        });
      }
    });
  });

  // THE SCROLL RULE (`chatScroll.ts`): follow the newest line only when already at the bottom;
  // while reading back, count what arrived and offer the "new messages" chip.
  let pinnedToEnd = true;
  let seenCount = 0;
  let unseen = $state(0);
  /** The line whose actions are open (a tap on a line), or null. */
  let openKey = $state<string | null>(null);

  const lineKey = (l: LiveChatLine) => `${l.authorId}:${l.clientId}`;

  function scrollToEnd() {
    if (list) list.scrollTop = list.scrollHeight;
  }

  $effect(() => {
    const count = lines.length;
    untrack(() => {
      const next = onLinesAdded(pinnedToEnd, unseen, count - seenCount);
      seenCount = count;
      unseen = next.unseen;
      if (next.follow) scrollToEnd();
    });
  });

  function onScroll() {
    if (!list) return;
    pinnedToEnd = isAtBottom(list);
    if (pinnedToEnd) unseen = 0;
  }

  function jumpToNewest() {
    pinnedToEnd = true;
    unseen = 0;
    scrollToEnd();
  }

  /** A tap on a line opens or closes its actions; an action closes them. */
  function toggleActions(key: string) {
    openKey = openKey === key ? null : key;
  }

  /** The words for a failure - the ONE mapping, the panel's and the composer's. */
  function failureText(failure: LiveChatSendFailure): string {
    switch (failure) {
      case 'empty':
        return m.live_chat_failed_empty();
      case 'too-long':
        return m.live_chat_failed_too_long({ max: maxChars ?? 0 });
      case 'too-fast':
        return m.live_chat_failed_too_fast();
      case 'network':
        return m.live_chat_failed_network();
      case 'muted':
        return m.live_chat_failed_muted();
      case 'removed':
        return m.live_chat_failed_removed();
      case 'ended':
        return m.live_chat_failed_ended();
      case 'refused':
        return m.live_chat_failed_refused();
      case 'unreadable':
        return m.live_chat_failed_unreadable();
    }
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    const text = draft;
    composerError = null;
    // The reader's own line is always shown: sending is the one thing that returns to the bottom.
    pinnedToEnd = true;
    // The field empties at once: the line is drawn as pending, and a failure stays on THAT line.
    draft = '';
    const failure = await send(text);
    if (failure === 'empty' || failure === 'too-long') {
      draft = text;
      composerError = failureText(failure);
    }
  }

  function nameOf(line: LiveChatLine): string {
    if (line.mine) return m.live_chat_you();
    return getUserDisplayNameSync(line.authorId) || m.live_chat_someone();
  }
</script>

<section
  class="pointer-events-auto relative flex max-h-[38vh] w-full max-w-md flex-col gap-2"
  aria-label={m.live_chat_label()}
  data-live-chat
>
  <!-- NO BOX (owner, 2026-10-31, "like Instagram Live"): lines float over the video in white with a
       shadow, each with its author's avatar. The list scrolls, the newest at the bottom, fading out
       at its top edge. A line is tapped for its actions (report, hide, retry): that is where the
       old always-visible eye-off button went. -->
  <ol
    bind:this={list}
    onscroll={onScroll}
    class="live-chat-list flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain pt-6"
    role="log"
    aria-live="polite"
    aria-relevant="additions"
  >
    {#each lines as line (lineKey(line))}
      {@const key = lineKey(line)}
      {@const id = line.id}
      {@const canReport = !!report && !line.mine && id !== null && line.status !== 'failed'}
      {@const canHide = canModerate && id !== null && line.status !== 'failed'}
      {@const hasActions = canReport || canHide}
      <li
        class="live-chat-line text-sm text-white"
        class:opacity-60={line.status === 'pending'}
        data-live-chat-line={line.id ?? 'pending'}
        data-live-chat-status={line.status}
      >
        {#snippet body()}
          <span class="shrink-0" aria-hidden="true"
            ><Avatar userId={line.authorId} size="xs" /></span
          >
          <span class="min-w-0 flex-1 break-words">
            <bdi class="font-bold">{nameOf(line)}</bdi>
            <bdi class="whitespace-pre-wrap" dir="auto"><EmojiText text={line.text} /></bdi>
            {#if line.status === 'pending'}
              <span class="sr-only">{m.live_chat_pending()}</span>
            {/if}
            {#if line.status === 'failed' && line.failure}
              <span
                class="text-banner-notice mt-0.5 block text-xs"
                data-live-chat-failure={line.failure}
              >
                {failureText(line.failure)}
              </span>
            {/if}
          </span>
        {/snippet}

        {#if hasActions}
          <button
            type="button"
            class="flex w-full items-start gap-2 rounded-lg text-start outline-none focus-visible:ring-2 focus-visible:ring-white"
            aria-expanded={openKey === key}
            aria-label={m.live_chat_line_actions({ name: nameOf(line) })}
            onclick={() => toggleActions(key)}
            data-live-chat-line-toggle
          >
            {@render body()}
          </button>
          {#if openKey === key}
            <div class="mt-1 flex gap-2 ps-8" data-live-chat-actions>
              {#if canReport}
                <button
                  type="button"
                  class="live-chat-action"
                  aria-label={m.live_chat_report({ name: nameOf(line) })}
                  onclick={() => {
                    openKey = null;
                    report?.(line);
                  }}
                  data-live-chat-report
                >
                  <Flag size={14} />
                  {m.live_chat_action_report()}
                </button>
              {/if}
              {#if canHide && id !== null}
                <button
                  type="button"
                  class="live-chat-action"
                  aria-label={m.live_chat_hide({ name: nameOf(line) })}
                  onclick={() => {
                    openKey = null;
                    hide(id);
                  }}
                  data-live-chat-hide
                >
                  <EyeOff size={14} />
                  {m.live_chat_action_hide()}
                </button>
              {/if}
            </div>
          {/if}
        {:else}
          <div class="flex items-start gap-2">
            {@render body()}
            {#if line.status === 'failed'}
              {#if line.failure === 'too-fast' || line.failure === 'network'}
                <button
                  type="button"
                  class="ui-icon-button shrink-0 rounded-full outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white"
                  aria-label={m.live_chat_retry()}
                  title={m.live_chat_retry()}
                  onclick={() => retry(line.clientId)}
                  data-live-chat-retry
                >
                  <RotateCcw size={18} />
                </button>
              {/if}
              <button
                type="button"
                class="ui-icon-button shrink-0 rounded-full outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white"
                aria-label={m.live_chat_discard()}
                title={m.live_chat_discard()}
                onclick={() => discard(line.clientId)}
                data-live-chat-discard
              >
                <Trash2 size={18} />
              </button>
            {/if}
          </div>
        {/if}
      </li>
    {/each}
  </ol>

  {#if unseen > 0}
    <button
      type="button"
      class="glass-chrome text-cn-dark absolute start-1/2 bottom-14 inline-flex min-h-9 -translate-x-1/2 items-center gap-1.5 rounded-full px-3 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-white"
      onclick={jumpToNewest}
      data-live-chat-new
    >
      <ArrowDown size={14} strokeWidth={2.5} />
      {m.live_chat_new_messages()}
    </button>
  {/if}

  {#if canWrite}
    <!-- The shared glass material (`.glass-chrome`, app.css): a thin pill, the send inside it. -->
    <form
      class="glass-chrome flex min-h-11 items-center gap-1 rounded-full ps-4 pe-1"
      onsubmit={submit}
      data-live-chat-composer
    >
      <input
        type="text"
        class="text-cn-dark placeholder:text-cn-dark/60 min-h-10 min-w-0 flex-1 bg-transparent text-sm outline-none"
        placeholder={m.live_chat_placeholder()}
        aria-label={m.live_chat_input_label()}
        aria-invalid={composerError !== null}
        aria-describedby={composerError !== null ? 'live-chat-composer-error' : undefined}
        maxlength={maxChars ?? undefined}
        enterkeyhint="send"
        autocomplete="off"
        bind:value={draft}
        data-live-chat-input
      />
      <button
        type="submit"
        class="ui-icon-button bg-cn-yellow text-cn-ink shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50"
        aria-label={m.live_chat_send()}
        title={m.live_chat_send()}
        disabled={draft.trim() === ''}
        data-live-chat-send
      >
        <SendHorizontal size={18} />
      </button>
    </form>
    {#if composerError !== null}
      <p id="live-chat-composer-error" class="text-banner-notice text-xs" role="alert">
        {composerError}
      </p>
    {/if}
  {/if}
</section>

<style>
  /* The oldest lines fade out at the top, over the video, rather than ending on a hard edge. */
  .live-chat-list {
    mask-image: linear-gradient(to bottom, transparent 0, var(--color-cn-scrim) 2.5rem);
  }
  /* White on a moving picture: the shadow, not a box, keeps a line legible. */
  .live-chat-line {
    text-shadow: 0 0.0625rem 0.25rem color-mix(in srgb, var(--color-cn-scrim) 85%, transparent);
  }
  .live-chat-action {
    display: inline-flex;
    min-height: 2rem;
    align-items: center;
    gap: 0.25rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-cn-scrim) 55%, transparent);
    padding: 0 0.75rem;
    font-size: var(--text-xs);
    font-weight: 600;
    text-shadow: none;
  }
</style>
