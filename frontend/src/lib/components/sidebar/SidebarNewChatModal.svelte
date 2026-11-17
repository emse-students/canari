<script lang="ts">
  import { Check, X } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import Modal from '../shared/Modal.svelte';
  import UserAutocomplete from '../shared/UserAutocomplete.svelte';
  import { m } from '$lib/paraglide/messages';
  import type { RecentDirectPeer } from '$lib/utils/chat/conversations';
  import { composeUnnamedGroupLabel } from '$lib/utils/chat/unnamedGroupLabel';
  import {
    getUserFirstNameSync,
    resolveUserDisplayName,
    seedUserDisplayName,
  } from '$lib/utils/users/displayName';

  interface Props {
    /** Whether the panel is visible. Opening it starts from an empty selection. */
    open: boolean;
    /** ID of the currently logged-in user: never offered, since nobody starts a conversation with themselves. */
    currentUserId?: string;
    /**
     * The people this account already talks to, most recent first - what the panel offers before a
     * single character is typed.
     */
    recentPeers?: RecentDirectPeer[];
    /**
     * The refusal to show, already localized, or `''` for none.
     *
     * A STRING RATHER THAN THE REASON CODE: this panel does not decide what a refusal means, and
     * giving it the discriminator would put the one exhaustive mapping (`conversationRefusalMessage`)
     * behind a second one here.
     */
    error?: string;
    /** True while a creation is in flight - the panel is open, the inputs are locked, and it says so. */
    busy?: boolean;
    /** Callback to close the panel. */
    onClose: () => void;
    /** ONE person chosen: open the conversation with them, or create it. */
    onStartDirect: (peerId: string) => void;
    /**
     * SEVERAL people chosen and the name step confirmed: create the group. `name` is `''` when the
     * member kept the suggestion - the group is then UNNAMED, and every device draws it by its
     * members' first names (owner, 2026-11-17).
     */
    onCreateGroup: (name: string, memberIds: string[]) => void;
  }

  let {
    open,
    currentUserId = '',
    recentPeers = [],
    error = '',
    busy = false,
    onClose,
    onStartDirect,
    onCreateGroup,
  }: Props = $props();

  /** The people chosen, in the order they were picked - the chips above the search. */
  let chosen = $state<{ id: string; name: string }[]>([]);
  /** The second step: the group's name, open once several people are chosen and the button pressed. */
  let naming = $state(false);
  let groupName = $state('');

  const chosenIds = $derived(chosen.map((p) => p.id));

  /*
   * EVERY OPENING STARTS FROM NOTHING. The selection lives here, not in the sidebar, because it is
   * the panel's own state: a refusal keeps it (the panel stays open), and closing ends it.
   */
  $effect(() => {
    if (!open) return;
    chosen = [];
    naming = false;
    groupName = '';
  });

  /**
   * What the group will be called if the member leaves the field empty: the same words every device
   * will draw for it (`composeUnnamedGroupLabel`), shown greyed as the field's placeholder - a
   * suggestion, never a value, so keeping it stores nothing.
   */
  const suggestedName = $derived(
    composeUnnamedGroupLabel(chosenIds, currentUserId, (id) =>
      getUserFirstNameSync(id, chosen.find((p) => p.id === id)?.name ?? id)
    ) ?? ''
  );

  /**
   * Adds or removes one person. A pick from the search seeds their name so the chip reads at once,
   * and asks their profile once, so the suggestion names them by their FIRST name.
   */
  function toggle(id: string, name: string) {
    if (busy) return;
    const key = id.trim().toLowerCase();
    if (!key || key === currentUserId.toLowerCase()) return;
    if (chosen.some((p) => p.id === key)) {
      chosen = chosen.filter((p) => p.id !== key);
      return;
    }
    chosen = [...chosen, { id: key, name }];
    void resolveUserDisplayName(key).catch((e: unknown) =>
      console.warn(`[NEW_CHAT] the profile of a chosen person could not be asked: ${String(e)}`)
    );
  }

  function pickFromSearch(user: { id: string; displayName: string | null }) {
    if (user.displayName) seedUserDisplayName(user.id, user.displayName);
    if (!chosenIds.includes(user.id.trim().toLowerCase())) {
      toggle(user.id, user.displayName || user.id);
    }
  }

  /** The footer's one action: one person opens the conversation, several open the name step. */
  function proceed() {
    if (busy || chosen.length === 0) return;
    if (chosen.length === 1) {
      onStartDirect(chosen[0].id);
      return;
    }
    naming = true;
  }

  function handleNameSubmit(e: Event) {
    e.preventDefault();
    if (busy || chosen.length < 2) return;
    onCreateGroup(groupName.trim(), chosenIds);
  }
</script>

<!--
  ONE PANEL FOR BOTH (owner, 2026-11-17). It used to hold two tabs: "Contact" opened a 1:1, "Groupe"
  asked for a name and created an EMPTY group whose members were added afterwards from its own panel.
  Now people are chosen first - chips above the search, the Messenger pattern - and the number chosen
  decides: one opens the conversation with that person, several open the name step, where keeping
  the suggestion creates an unnamed group. docs/wiki/frontend/modules/chat.md#one-new-discussion-panel

  `bodyClass` REPLACES the modal's own `overflow-y-auto`, deliberately: the chips and the field hold
  their size, and the ONE thing that scrolls is the list.
-->
<Modal
  {open}
  {onClose}
  topAnchored
  title={m.chat_new_discussion_title()}
  bodyClass="flex min-h-0 flex-col overflow-hidden"
>
  <div class="flex min-h-0 flex-1 flex-col">
    {#if chosen.length > 0}
      <ul
        class="mb-3 flex shrink-0 flex-wrap gap-2"
        aria-label={m.chat_modal_selected_people_label()}
        data-testid="new-chat-chips"
      >
        {#each chosen as person (person.id)}
          <li
            class="bg-accent/15 text-text-main flex items-center gap-1 rounded-full py-1 pr-1 pl-3 text-sm font-medium"
          >
            <EmojiText text={person.name} />
            <Button
              variant="ghost"
              size="compact"
              icon
              onclick={() => toggle(person.id, person.name)}
              disabled={busy}
              class="rounded-full"
              aria-label={m.chat_modal_remove_person_label({ name: person.name })}
            >
              <X size={14} aria-hidden="true" />
            </Button>
          </li>
        {/each}
      </ul>
    {/if}

    <label for="new-chat-search" class="sr-only">{m.chat_modal_search_user_placeholder()}</label>
    <!--
      Your own account is not a conversation you can start, so it is not offered; nor is anyone
      already chosen, who is removed by their chip.
    -->
    <UserAutocomplete
      value=""
      onValueChange={() => {}}
      onSelect={pickFromSearch}
      clearOnSelect
      placeholder={m.chat_modal_search_user_placeholder()}
      inputId="new-chat-search"
      excludeIds={[...(currentUserId ? [currentUserId] : []), ...chosenIds]}
    />

    <!--
      THE PANEL OPENS ON A LIST: the people this account already talks to, from the rows the sidebar
      already holds - no new endpoint, and no directory of every account in the school. A row is a
      toggle, so a group of familiar people takes a tap each.
    -->
    {#if recentPeers.length > 0}
      <div class="mt-5 flex min-h-0 flex-1 flex-col">
        <p class="text-text-muted text-2xs mb-2 font-bold">
          {m.chat_modal_recent_peers_label()}
        </p>
        <ul class="-mx-2 min-h-0 flex-1 overflow-y-auto">
          {#each recentPeers as peer (peer.peerId)}
            {@const selected = chosenIds.includes(peer.peerId.toLowerCase())}
            <li>
              <Button
                variant="bare"
                aria-pressed={selected}
                disabled={busy}
                onclick={() => toggle(peer.peerId, peer.displayName)}
                class="text-text-main hover:bg-accent/20 flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left text-sm font-medium transition-colors"
              >
                <Avatar userId={peer.peerId} size="md" />
                <span class="min-w-0 flex-1 truncate"><EmojiText text={peer.displayName} /></span>
                <span
                  class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border {selected
                    ? 'bg-accent border-accent text-on-accent'
                    : 'border-text-muted/40'}"
                  aria-hidden="true"
                >
                  {#if selected}<Check size={13} strokeWidth={3} />{/if}
                </span>
              </Button>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>

  <!--
    THE REFUSAL OF A 1:1 is said here; a group's is said in the name step, which is on top of this
    panel while it is open. `role="alert"` makes a screen reader announce a line that appears
    seconds after the button was pressed, which is exactly when this one does.
  -->
  {#if error && !naming}
    <p
      role="alert"
      class="mt-4 shrink-0 rounded-xl border border-red-400/40 bg-red-500/10 px-3 py-2 text-center text-xs font-medium text-red-600 dark:text-red-300"
    >
      {error}
    </p>
  {/if}

  {#snippet footer()}
    <Button class="w-full" type="button" onclick={proceed} disabled={chosen.length === 0 || busy}>
      {busy && !naming
        ? m.chat_modal_creation_in_progress_label()
        : chosen.length >= 2
          ? m.chat_modal_create_group_with_button({ count: chosen.length })
          : m.chat_modal_start_discussion_button()}
    </Button>
  {/snippet}
</Modal>

<!--
  THE NAME STEP, a second panel over the first (owner, 2026-11-17). The field is EMPTY and its
  placeholder is the members' first names: keeping it creates an unnamed group, which stores no
  name anywhere and keeps naming its members as they come and go.
-->
<Modal
  open={open && naming}
  onClose={() => (naming = false)}
  title={m.chat_group_name_modal_title()}
>
  <form id="new-group-form" class="space-y-2" onsubmit={handleNameSubmit}>
    <Input
      id="new-group-name"
      label={m.chat_modal_group_name_label()}
      bind:value={groupName}
      disabled={busy}
      placeholder={suggestedName}
      autocomplete="off"
    />
    <p class="text-text-muted text-xs">{m.chat_group_name_modal_hint()}</p>
  </form>
  {#if error}
    <p
      role="alert"
      class="mt-4 rounded-xl border border-red-400/40 bg-red-500/10 px-3 py-2 text-center text-xs font-medium text-red-600 dark:text-red-300"
    >
      {error}
    </p>
  {/if}
  {#snippet footer()}
    <Button class="w-full" type="submit" form="new-group-form" disabled={busy}>
      {busy ? m.chat_modal_creation_in_progress_label() : m.chat_modal_create_group_button()}
    </Button>
  {/snippet}
</Modal>
