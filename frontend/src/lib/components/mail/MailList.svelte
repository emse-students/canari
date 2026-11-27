<script lang="ts">
  /**
   * THE CONVERSATION LIST: search, quick filters, the rows, the next page, pull to refresh, and the
   * row swipes (docs/wiki/mail-client-transport.md#as-built---lot-3).
   *
   * THE SWIPE IS HEARD ONCE, ON THE LIST, AND ONLY ON A TOUCH SCREEN. A non-passive `touchmove`
   * costs its scroller the compositor for as long as it is bound (durable rules), so ONE listener
   * serves every row, and it is bound only where the gesture can happen - a coarse pointer
   * (`isCoarsePointerDevice`). A mouse has the selection and the actions bar instead. The stroke's
   * direction is decided once under the engine's slop and every move from the lock on is claimed
   * (`claimTouchMove`), because WebKit applies the vertical drift of a horizontal stroke to the
   * scroller otherwise.
   */
  import { Inbox, LoaderCircle, Search } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import MailRow from './MailRow.svelte';
  import MailStatePanel from './MailStatePanel.svelte';
  import { nearViewport } from '$lib/actions/nearViewport';
  import { pullToRefresh } from '$lib/actions/pullToRefresh';
  import { m } from '$lib/paraglide/messages';
  import type { MailStore } from '$lib/mail/mailStore.svelte';
  import {
    mailSwipeAction,
    mailSwipeOffset,
    mailSwipePhase,
    type MailSwipeAction,
    type MailSwipePhase,
    type MailSwipeSides,
  } from '$lib/mail/mailGestures';
  import { MAIL_LIST_FILTERS, type MailListFilter } from '$lib/mail/mailFormat';
  import { mailErrorRetryable, mailErrorText } from '$lib/mail/mailErrorText';
  import { claimTouchMove } from '$lib/utils/touchClaim';
  import { isCoarsePointerDevice } from '$lib/utils/pointerDevice';
  import { Log } from '$lib/utils/Log';

  interface Props {
    store: MailStore;
    self: readonly string[];
    sides: MailSwipeSides;
    /** The conversation open beside the list (wide layout), if any. */
    activeId: string | null;
    search: string;
    filter: MailListFilter;
    /** The reader submitted a search, or picked a filter. */
    onQuery: (search: string, filter: MailListFilter) => void;
    onOpen: (id: string) => void;
    /** A completed swipe. */
    onSwipe: (action: MailSwipeAction, id: string) => void;
    /** Pull to refresh and "Réessayer": the folders and the list again. */
    onRefresh: () => Promise<void>;
  }

  let {
    store,
    self,
    sides,
    activeId,
    search = $bindable(),
    filter,
    onQuery,
    onOpen,
    onSwipe,
    onRefresh,
  }: Props = $props();

  /** The reference instant of the row dates, taken when the list is (re)listed - never ticking. */
  const now = $derived.by(() => {
    void store.conversations;
    return Date.now();
  });

  const FILTER_LABELS: Record<MailListFilter, () => string> = {
    all: m.mail_filter_all,
    unread: m.mail_filter_unread,
    flagged: m.mail_filter_flagged,
    attachment: m.mail_filter_attachment,
  };

  /** The stroke under way: the row it began on, where, and what it has become. */
  let stroke: { id: string; x: number; y: number; phase: MailSwipePhase } | null = null;
  let swipe = $state<{ id: string; offset: number } | null>(null);

  function endStroke(act: boolean) {
    const current = swipe;
    stroke = null;
    swipe = null;
    if (!act || !current) return;
    const action = mailSwipeAction(current.offset, sides);
    if (action) {
      Log.d('MAIL-UI', `row swiped: ${action}`);
      onSwipe(action, current.id);
    }
  }

  /** Binds the swipe's touch listeners on a touch screen only (see the module comment). */
  function rowSwipes(node: HTMLElement) {
    if (!isCoarsePointerDevice()) return;
    const start = (e: TouchEvent) => {
      if (store.selected.length > 0 || e.touches.length !== 1) return;
      const row = (e.target as Element | null)?.closest<HTMLElement>('[data-conversation-id]');
      const id = row?.dataset.conversationId;
      if (!id) return;
      stroke = { id, x: e.touches[0].clientX, y: e.touches[0].clientY, phase: 'pending' };
    };
    const move = (e: TouchEvent) => {
      if (!stroke) return;
      const dx = e.touches[0].clientX - stroke.x;
      const dy = e.touches[0].clientY - stroke.y;
      stroke.phase = mailSwipePhase(stroke.phase, dx, dy);
      if (stroke.phase === 'vertical') {
        endStroke(false);
        return;
      }
      if (stroke.phase !== 'horizontal') return;
      if (!claimTouchMove(e)) {
        Log.d('MAIL-UI', 'a row swipe met a move the scroller owns - released');
        endStroke(false);
        return;
      }
      swipe = { id: stroke.id, offset: mailSwipeOffset(dx, sides) };
    };
    const end = () => endStroke(true);
    const cancel = () => endStroke(false);
    node.addEventListener('touchstart', start, { passive: true });
    node.addEventListener('touchmove', move, { passive: false });
    node.addEventListener('touchend', end, { passive: true });
    node.addEventListener('touchcancel', cancel, { passive: true });
    return {
      destroy() {
        node.removeEventListener('touchstart', start);
        node.removeEventListener('touchmove', move);
        node.removeEventListener('touchend', end);
        node.removeEventListener('touchcancel', cancel);
      },
    };
  }

  function submitSearch(event: SubmitEvent) {
    event.preventDefault();
    onQuery(search, filter);
  }

  const empty = $derived(!store.loading && !store.error && store.conversations.length === 0);
</script>

<div class="flex min-h-0 flex-1 flex-col" data-mail-list>
  <form class="px-4 pb-2" role="search" onsubmit={submitSearch}>
    <label class="sr-only" for="mail-search">{m.mail_search_label()}</label>
    <div class="relative">
      <Search
        size={18}
        class="text-text-muted pointer-events-none absolute top-1/2 left-3 z-10 -translate-y-1/2"
        aria-hidden="true"
      />
      <Input
        id="mail-search"
        type="search"
        bind:value={search}
        placeholder={m.mail_search_placeholder()}
        class="[&_input]:rounded-full [&_input]:pl-10"
        enterkeyhint="search"
      />
    </div>
  </form>

  <div class="flex flex-wrap gap-2 px-4 pb-2" data-mail-filters>
    {#each MAIL_LIST_FILTERS as option (option)}
      <Button
        size="compact"
        variant={option === filter ? 'primary' : 'secondary'}
        class="rounded-full"
        aria-pressed={option === filter}
        onclick={() => onQuery(search, option)}
      >
        {FILTER_LABELS[option]()}
      </Button>
    {/each}
  </div>

  <div
    class="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
    use:pullToRefresh={{ onRefresh, enabled: () => store.selected.length === 0 }}
  >
    {#if store.error && store.conversations.length === 0}
      <MailStatePanel
        Icon={Inbox}
        tone="error"
        title={mailErrorText(store.error.kind)}
        onRetry={mailErrorRetryable(store.error.kind) ? () => void onRefresh() : undefined}
        busy={store.loading}
      />
    {:else if empty}
      <MailStatePanel
        Icon={Inbox}
        title={store.query ? m.mail_list_empty_search() : m.mail_list_empty()}
      />
    {:else}
      <ul class="flex flex-col" use:rowSwipes aria-busy={store.loading}>
        {#each store.conversations as conversation (conversation.id)}
          {@const offset = swipe?.id === conversation.id ? swipe.offset : 0}
          <MailRow
            {conversation}
            {self}
            {now}
            selected={store.selected.includes(conversation.id)}
            selecting={store.selected.length > 0}
            active={conversation.id === activeId}
            {offset}
            armed={offset !== 0 ? mailSwipeAction(offset, sides) : null}
            {onOpen}
            onToggle={(id) => store.toggle(id)}
          />
        {/each}
      </ul>
      {#if store.hasMore}
        {#key store.conversations.length}
          <div
            class="flex justify-center py-4"
            use:nearViewport={{ onnear: () => void store.loadMore(), rootMargin: '600px' }}
          >
            <LoaderCircle size={22} class="text-text-muted animate-spin" aria-hidden="true" />
            <span class="sr-only">{m.mail_loading()}</span>
          </div>
        {/key}
      {:else if store.loading}
        <div class="flex justify-center py-4" role="status">
          <LoaderCircle size={22} class="text-text-muted animate-spin" aria-hidden="true" />
          <span class="sr-only">{m.mail_loading()}</span>
        </div>
      {/if}
      {#if store.error}
        <p class="text-red-err px-4 py-2 text-sm" role="alert">{mailErrorText(store.error.kind)}</p>
      {/if}
    {/if}
  </div>
</div>
