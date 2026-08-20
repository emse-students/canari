<script lang="ts">
  import Modal from '../shared/Modal.svelte';
  import UserAutocomplete from '../shared/UserAutocomplete.svelte';
  import { m } from '$lib/paraglide/messages';

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
    /** Callback to close the modal. */
    onClose: () => void;
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
    onClose,
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
    'bg-white/80 dark:bg-black/40 text-text-main border border-white/60 dark:border-white/10 shadow-sm';
  const inactiveTabClass =
    'text-text-muted hover:text-text-main hover:bg-white/35 dark:hover:bg-black/30 border border-transparent';

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

<Modal {open} {onClose} title={m.chat_new_discussion_title()}>
  <!-- Système d'onglets accessible -->
  <div
    role="tablist"
    class="mb-4 flex gap-2 rounded-2xl border border-white/50 bg-white/45 p-1 dark:border-white/10 dark:bg-black/25"
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
    <div id="tabpanel-contact" role="tabpanel" aria-labelledby="tab-contact">
      <form class="space-y-4" onsubmit={handleContactSubmit}>
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
        <button
          type="submit"
          disabled={!contactId.trim() || isSelf}
          class="w-full rounded-xl bg-amber-500 py-2.5 font-semibold text-white transition-all duration-200 hover:bg-amber-400 focus:ring-2 focus:ring-amber-500/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          {m.chat_modal_start_discussion_button()}
        </button>
        {#if isSelf}
          <p class="-mt-1 text-center text-xs font-medium text-red-500">
            {m.chat_modal_self_conversation_error()}
          </p>
        {/if}
      </form>
    </div>
  {:else if activeTab === 'group'}
    <div id="tabpanel-group" role="tabpanel" aria-labelledby="tab-group">
      <form class="space-y-4" onsubmit={handleGroupSubmit}>
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
            class="placeholder:text-text-muted/70 w-full rounded-xl border border-white/60 bg-white/65 px-4 py-2.5 text-sm transition-all outline-none focus:border-amber-400/50 focus:ring-2 focus:ring-amber-400/45 dark:border-white/10 dark:bg-black/30"
            autocomplete="off"
          />
        </div>
        <button
          type="submit"
          disabled={!groupName.trim()}
          class="w-full rounded-xl bg-amber-500 py-2.5 font-semibold text-white transition-all duration-200 hover:bg-amber-400 focus:ring-2 focus:ring-amber-500/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          {m.chat_modal_create_group_button()}
        </button>
      </form>
    </div>
  {/if}
</Modal>
