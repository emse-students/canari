<script lang="ts">
  /**
   * THE ONE CONVERSATION PICKER LIST: a search field, then titled sections of conversation rows -
   * the avatar (a DM's peer, a group's picture, a salon's "#"), the name, a subtitle, and a trailing
   * mark the caller draws. Used by the forward / share picker (`ForwardMessageModal`: one untitled
   * section, a tap picks) and by the camera's "Envoyer a..." sheet (`ReelSendSheet`: "Publier",
   * "Recents" and the rest, a tap ticks) - owner, 2026-11-16: the reel list is built on the share
   * list, not beside it.
   *
   * IT DECIDES NOTHING. Which rows, in which section and order, is the caller's (`shareCandidates`,
   * `reelSendSections`); what a tap does, the row's role and accessible name, whether it is
   * disabled, are the caller's too (`onpick`, `rowAttrs`). It only draws them the same way.
   *
   * IT DRAWS NO CONTROL BY HAND (controls.md): the search is `ui/Input`, a row is a `ui/Button`
   * `bare` - one tap on a surface that draws itself.
   */
  import type { Snippet } from 'svelte';
  import { Hash, Search } from '@lucide/svelte';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import GroupAvatar from '$lib/components/shared/GroupAvatar.svelte';
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import { currentUserId } from '$lib/stores/user';
  import type { PickerSection, ShareCandidate } from '$lib/sharing/shareDestinations';

  /**
   * What a caller sets on a row: its ARIA role and state, whether it is disabled, test hooks. Never
   * its click or its classes - those are `onpick` and `rowClass`.
   */
  type PickRowAttrs = { disabled?: boolean } & Record<string, unknown>;

  interface Props {
    /** The search field's text, bound: the caller filters its rows on it. */
    query: string;
    searchPlaceholder: string;
    searchLabel: string;
    /** Extra attributes on the search field (a test hook). */
    searchAttrs?: Record<string, string>;
    sections: PickerSection[];
    /** Said in place of the sections when they hold no row. */
    emptyText: string;
    /** Extra attributes on the empty sentence (a test hook). */
    emptyAttrs?: Record<string, string>;
    /** A titled block drawn BEFORE the sections, whatever they hold ("Publier" in the send sheet). */
    lead?: { title: string; body: Snippet };
    /** Lines between the lead and the sections (why some rows are disabled). */
    notice?: Snippet;
    /** The row was tapped. */
    onpick: (cand: ShareCandidate) => void;
    /** The row button's role, accessible name, state and test hooks. */
    rowAttrs?: (cand: ShareCandidate) => PickRowAttrs;
    /** Extra classes on a row (a highlighted suggestion). */
    rowClass?: (cand: ShareCandidate) => string;
    /** A second line under a group's name (a few of its members), when no community names it. */
    subtitle?: (cand: ShareCandidate) => string | null;
    /** The name may carry emoji drawn as images (`EmojiText`); the forward picker keeps plain text. */
    emojiNames?: boolean;
    /** The mark at the row's end (an arrow, a round tick). */
    trailing: Snippet<[ShareCandidate]>;
    /** The root's classes: the picker sits in a modal or fills a sheet. */
    class?: string;
    /** The scrolling list's classes. */
    listClass?: string;
  }

  let {
    query = $bindable(),
    searchPlaceholder,
    searchLabel,
    searchAttrs = {},
    sections,
    emptyText,
    emptyAttrs = {},
    lead,
    notice,
    onpick,
    rowAttrs,
    rowClass,
    subtitle,
    emojiNames = false,
    trailing,
    class: rootClass = 'flex flex-col gap-3',
    listClass = '-mx-1 flex max-h-[50vh] flex-col gap-0.5 overflow-y-auto px-1',
  }: Props = $props();

  const isEmpty = $derived(sections.every((s) => s.rows.length === 0));

  const SECTION_TITLE = 'text-text-muted px-2 pt-3 pb-1 text-xs font-semibold';
</script>

<div class={rootClass}>
  <div class="relative">
    <Search
      size={16}
      class="text-text-muted pointer-events-none absolute top-1/2 left-3 z-10 -translate-y-1/2"
    />
    <Input
      type="text"
      bind:value={query}
      placeholder={searchPlaceholder}
      aria-label={searchLabel}
      style="padding-inline-start: 2.25rem"
      {...searchAttrs}
    />
  </div>

  <div class={listClass}>
    {#if lead}
      <h2 class={SECTION_TITLE} data-picker-section="lead">{lead.title}</h2>
      {@render lead.body()}
    {/if}
    {#if notice}
      {@render notice()}
    {/if}
    {#if isEmpty}
      <p class="text-text-muted py-8 text-center text-sm" {...emptyAttrs}>{emptyText}</p>
    {:else}
      {#each sections as section (section.id)}
        {#if section.title !== null && section.rows.length > 0}
          <h2 class={SECTION_TITLE} data-picker-section={section.id}>{section.title}</h2>
        {/if}
        {#each section.rows as cand (cand.key)}
          {@const second = cand.community ? null : (subtitle?.(cand) ?? null)}
          <Button
            variant="bare"
            onclick={() => onpick(cand)}
            class="flex items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors enabled:hover:bg-black/5 dark:enabled:hover:bg-white/5
 {rowClass?.(cand) ?? ''}"
            {...rowAttrs?.(cand)}
          >
            {#if cand.conversation.conversationType === 'direct'}
              <Avatar
                userId={cand.conversation.directPeerId ?? cand.conversation.contactName}
                size="md"
                fallbackLabel={cand.label}
              />
            {:else if cand.conversation.conversationType === 'self'}
              <div data-self-conversation-icon>
                <Avatar userId={currentUserId() ?? ''} size="md" fallbackLabel={cand.label} />
              </div>
            {:else if cand.conversation.conversationType === 'channel'}
              <div class="text-text-muted flex h-8 w-8 shrink-0 items-center justify-center">
                <Hash size={18} strokeWidth={2.5} />
              </div>
            {:else}
              <GroupAvatar
                id={cand.conversation.id}
                imageMediaId={cand.conversation.imageMediaId}
                name={cand.label}
                size="md"
              />
            {/if}
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="text-text-main truncate text-sm font-semibold">
                {#if emojiNames}<EmojiText text={cand.label} />{:else}{cand.label}{/if}
              </span>
              {#if cand.community}
                <span class="text-text-muted flex items-center gap-1 truncate text-xs">
                  <Hash size={11} class="shrink-0" />
                  <EmojiText text={cand.community} />
                </span>
              {:else if second}
                <span class="text-text-muted truncate text-xs" data-picker-subtitle>{second}</span>
              {/if}
            </span>
            {@render trailing(cand)}
          </Button>
        {/each}
      {/each}
    {/if}
  </div>
</div>
