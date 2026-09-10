<script lang="ts">
  import Modal from '../shared/Modal.svelte';
  import UserAutocomplete from '../shared/UserAutocomplete.svelte';
  import { m } from '$lib/paraglide/messages';
  import type { RecentDirectPeer } from '$lib/utils/chat/conversations';

  interface Props {
    /** Whether the modal is visible. */
    open: boolean;
    /** Which tab is currently active inside the modal. */
    activeTab: 'contact' | 'group';
    /** Current value of the contact identifier input. */
    contactId: string;
    /** Current value of the group name input. */
    groupName: string;
    /** ID of the currently logged-in user, used to prevent self-conversation. */
    currentUserId?: string;
    /**
     * The people this account already talks to, most recent first - what the panel shows before a
     * single character is typed, in place of the ~600px of nothing a bare search field left.
     */
    recentPeers?: RecentDirectPeer[];
    /** Callback to close the modal. */
    onClose: () => void;
    /** Called when one of `recentPeers` is chosen: fills the field AND starts the conversation. */
    onPickPeer?: (peerId: string) => void;
    /** Callback fired when the user switches between contact and group tabs. */
    onTabChange: (tab: 'contact' | 'group') => void;
    /** Callback fired when the contact identifier input changes. */
    onContactIdChange: (value: string) => void;
    /** Callback fired when the group name input changes. */
    onGroupNameChange: (value: string) => void;
    /** Callback to start a direct conversation with the entered contact. */
    onSubmitContact: () => void;
    /** Callback to create a new group conversation. */
    onSubmitGroup: () => void;
  }

  let {
    open,
    activeTab,
    contactId,
    groupName,
    currentUserId = '',
    recentPeers = [],
    onClose,
    onPickPeer,
    onTabChange,
    onContactIdChange,
    onGroupNameChange,
    onSubmitContact,
    onSubmitGroup,
  }: Props = $props();

  let isSelf = $derived(
    !!currentUserId && contactId.trim().toLowerCase() === currentUserId.toLowerCase()
  );

  // Class utilities to keep the HTML template clean
  const baseTabClass =
    'flex-1 px-3 py-2 text-sm font-semibold rounded-xl transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-amber-400';
  const activeTabClass =
    'bg-cn-surface dark:bg-black/40 text-text-main border border-white/60 dark:border-white/10 shadow-sm';
  const inactiveTabClass =
    'text-text-muted hover:text-text-main hover:bg-white/35 dark:hover:bg-black/30 border border-transparent';

  /**
   * The list is shown only while the field is EMPTY, because `UserAutocomplete` opens its own
   * dropdown from the first keystroke and two lists competing for the same space is worse than the
   * blank panel this replaces. Typing is the filter; the list is what "no filter" looks like.
   */
  const showRecents = $derived(
    activeTab === 'contact' && !contactId.trim() && recentPeers.length > 0
  );

  // Gestionnaires de soumission natifs
  function handleContactSubmit(e: Event) {
    e.preventDefault();
    if (contactId.trim() && !isSelf) onSubmitContact();
  }

  function handleGroupSubmit(e: Event) {
    e.preventDefault();
    if (groupName.trim()) onSubmitGroup();
  }
</script>

<!--
  `bodyClass` REPLACES the modal's own `overflow-y-auto`, deliberately. The default body is one
  scrolling block, and a list that scrolls inside a block that also scrolls gives the reader two
  scrollbars for one list and a header that drifts away with it. The body is a column here: the tabs
  and the field hold their size, and the ONE thing that scrolls is the list.
-->
<Modal
  {open}
  {onClose}
  topAnchored
  title={m.chat_new_discussion_title()}
  bodyClass="flex min-h-0 flex-col overflow-hidden"
>
  <!-- Système d'onglets accessible -->
  <div
    role="tablist"
    class="bg-cn-surface mb-4 flex shrink-0 gap-2 rounded-2xl border border-white/50 p-1 dark:border-white/10"
  >
    <button
      id="tab-contact"
      role="tab"
      aria-selected={activeTab === 'contact'}
      aria-controls="tabpanel-contact"
      class="{baseTabClass} {activeTab === 'contact' ? activeTabClass : inactiveTabClass}"
      onclick={() => onTabChange('contact')}
    >
      {m.chat_modal_contact_tab()}
    </button>
    <button
      id="tab-group"
      role="tab"
      aria-selected={activeTab === 'group'}
      aria-controls="tabpanel-group"
      class="{baseTabClass} {activeTab === 'group' ? activeTabClass : inactiveTabClass}"
      onclick={() => onTabChange('group')}
    >
      {m.chat_modal_group_tab()}
    </button>
  </div>

  <!-- Contenu des onglets -->
  {#if activeTab === 'contact'}
    <div
      id="tabpanel-contact"
      role="tabpanel"
      aria-labelledby="tab-contact"
      class="flex min-h-0 flex-1 flex-col"
    >
      <form id="new-contact-form" class="space-y-4" onsubmit={handleContactSubmit}>
        <div>
          <label for="new-contact-id" class="text-text-main mb-1 block text-sm font-medium">
            {m.chat_modal_contact_label()}
          </label>
          <!--
            Your own account is not a conversation you can start, so it is not offered. The
            `isSelf` guard below stays: this excludes self from THIS surface's suggestions, it does
            not make the id unreachable, and the guard is what covers a `contactId` arriving from
            anywhere else. Note the exclusion is scoped here rather than built into the picker -
            elsewhere in the app, finding yourself is exactly what the search is for.
          -->
          <UserAutocomplete
            value={contactId}
            onValueChange={onContactIdChange}
            placeholder={m.chat_modal_search_user_placeholder()}
            inputId="new-contact-id"
            excludeIds={currentUserId ? [currentUserId] : []}
            onSubmit={onSubmitContact}
          />
        </div>
        {#if isSelf}
          <p class="text-center text-xs font-medium text-red-500">
            {m.chat_modal_self_conversation_error()}
          </p>
        {/if}
      </form>

      <!--
        THE PANEL OPENS ON A LIST, WHICH IS THE WHOLE FIX. A search field has nothing to show before
        a keystroke, so this drew its controls in the top ~230px and left ~600px blank underneath on
        a 436x945 phone. These are the conversations already in the sidebar - no new endpoint, and no
        disclosure question, which a directory of every account in the school WOULD be.
      -->
      {#if showRecents}
        <div class="mt-5 flex min-h-0 flex-1 flex-col">
          <p class="text-text-muted text-2xs mb-2 font-bold tracking-widest uppercase">
            {m.chat_modal_recent_peers_label()}
          </p>
          <ul class="-mx-2 min-h-0 flex-1 overflow-y-auto">
            {#each recentPeers as peer (peer.peerId)}
              <li>
                <button
                  type="button"
                  onclick={() => onPickPeer?.(peer.peerId)}
                  class="text-text-main w-full rounded-xl px-2 py-2.5 text-left text-sm font-medium transition-colors outline-none hover:bg-amber-100/50 focus-visible:bg-amber-100/50 dark:hover:bg-amber-900/30 dark:focus-visible:bg-amber-900/30"
                >
                  {peer.displayName}
                </button>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>
  {:else if activeTab === 'group'}
    <div id="tabpanel-group" role="tabpanel" aria-labelledby="tab-group">
      <form id="new-group-form" class="space-y-4" onsubmit={handleGroupSubmit}>
        <div>
          <label for="new-group-name" class="text-text-main mb-1 block text-sm font-medium">
            {m.chat_modal_group_name_label()}
          </label>
          <input
            id="new-group-name"
            type="text"
            value={groupName}
            oninput={(e) => onGroupNameChange(e.currentTarget.value)}
            placeholder={m.chat_modal_group_name_placeholder()}
            class="placeholder:text-text-muted/70 bg-cn-surface w-full rounded-xl border border-white/60 px-4 py-2.5 text-sm transition-all outline-none focus:border-amber-400/50 focus:ring-2 focus:ring-amber-400/45 dark:border-white/10"
            autocomplete="off"
          />
        </div>
      </form>
    </div>
  {/if}

  <!--
    THE PRIMARY ACTION IS AT THE BOTTOM EDGE, not under the field. On a full-height panel it used to
    float mid-screen with the dead space BELOW it, which reads as an unfinished layout; and now that
    the list can scroll, a button that scrolled away with it would be worse still. `form=` is what
    keeps a submit button working from outside its own form.
  -->
  {#snippet footer()}
    {#if activeTab === 'contact'}
      <button
        type="submit"
        form="new-contact-form"
        disabled={!contactId.trim() || isSelf}
        class="text-cn-ink w-full rounded-xl bg-amber-500 py-2.5 font-semibold transition-all duration-200 hover:bg-amber-400 focus:ring-2 focus:ring-amber-500/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
      >
        {m.chat_modal_start_discussion_button()}
      </button>
    {:else}
      <button
        type="submit"
        form="new-group-form"
        disabled={!groupName.trim()}
        class="text-cn-ink w-full rounded-xl bg-amber-500 py-2.5 font-semibold transition-all duration-200 hover:bg-amber-400 focus:ring-2 focus:ring-amber-500/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
      >
        {m.chat_modal_create_group_button()}
      </button>
    {/if}
  {/snippet}
</Modal>
