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
  import { EyeOff, Flag, RotateCcw, SendHorizontal, Trash2 } from '@lucide/svelte';
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
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

  // The newest line in view after every change, unless the reader scrolled up to read back.
  let pinnedToEnd = true;
  $effect(() => {
    void lines.length;
    const el = untrack(() => list);
    if (el && pinnedToEnd) el.scrollTop = el.scrollHeight;
  });

  function onScroll() {
    if (!list) return;
    pinnedToEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
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
  class="pointer-events-auto flex max-h-[40vh] w-full max-w-md flex-col gap-2"
  aria-label={m.live_chat_label()}
  data-live-chat
>
  <ol
    bind:this={list}
    onscroll={onScroll}
    class="live-chat-list flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain"
    role="log"
    aria-live="polite"
    aria-relevant="additions"
  >
    {#each lines as line (`${line.authorId}:${line.clientId}`)}
      <li
        class="group bg-cn-scrim/60 flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-sm"
        class:opacity-60={line.status === 'pending'}
        data-live-chat-line={line.id ?? 'pending'}
        data-live-chat-status={line.status}
      >
        <p class="min-w-0 flex-1 break-words">
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
        </p>
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
        {:else}
          {#if report && !line.mine && line.id !== null}
            <button
              type="button"
              class="ui-icon-button shrink-0 rounded-full outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white"
              aria-label={m.live_chat_report({ name: nameOf(line) })}
              title={m.live_chat_report({ name: nameOf(line) })}
              onclick={() => report(line)}
              data-live-chat-report
            >
              <Flag size={18} />
            </button>
          {/if}
          {#if canModerate && line.id !== null}
            {@const id = line.id}
            <button
              type="button"
              class="ui-icon-button shrink-0 rounded-full outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white"
              aria-label={m.live_chat_hide({ name: nameOf(line) })}
              title={m.live_chat_hide({ name: nameOf(line) })}
              onclick={() => hide(id)}
              data-live-chat-hide
            >
              <EyeOff size={18} />
            </button>
          {/if}
        {/if}
      </li>
    {/each}
  </ol>

  {#if canWrite}
    <form class="flex items-center gap-2" onsubmit={submit} data-live-chat-composer>
      <input
        type="text"
        class="bg-cn-scrim/60 min-h-11 min-w-0 flex-1 rounded-full px-4 text-sm text-white outline-none placeholder:text-white/60 focus-visible:ring-2 focus-visible:ring-white"
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
        <SendHorizontal size={20} />
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
    mask-image: linear-gradient(to bottom, transparent 0, var(--color-cn-scrim) 1.5rem);
  }
</style>
