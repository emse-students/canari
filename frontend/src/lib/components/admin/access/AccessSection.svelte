<script lang="ts">
  /**
   * THE ONE SHAPE OF AN ACCESS LIST on `/admin/read-access` (user, 2026-10-16: "uniformiser").
   *
   * Both tabs - named readers and document reviewers - are the same four parts in the same order:
   * a one-line summary with its explanation behind "Learn more", a person search with ONE primary
   * button, the list of people as cards (or the shared empty state), and the journal folded under
   * the list with its count. The page used to draw each part twice, differently.
   */
  import type { Component, Snippet } from 'svelte';
  import { UserPlus } from '@lucide/svelte';
  import UserAutocomplete from '$lib/components/shared/UserAutocomplete.svelte';
  import EmptyState from '$lib/components/shared/EmptyState.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { m } from '$lib/paraglide/messages';
  import type { JournalLine } from '$lib/admin/readAccess';

  interface Props {
    /** The section heading; visually hidden when a tab above already names the section. */
    title: string;
    titleHidden?: boolean;
    summary: string;
    /** The full explanation, behind the "Learn more" disclosure. */
    details: string;
    addPlaceholder: string;
    addLabel: string;
    /** Unique per section: the search input's id. */
    inputId: string;
    /** Users the search must not offer (already in the list). */
    excludeIds?: string[];
    /** Called with the picked user id; the field clears once it resolves. */
    onAdd: (userId: string) => void | Promise<void>;
    adding?: boolean;
    loading: boolean;
    count: number;
    emptyIcon: Component;
    emptyTitle: string;
    emptyDescription: string;
    /** The cards, rendered when `count > 0`. */
    list: Snippet;
    /** A line under the list (a footnote about the data). */
    footnote?: string;
    journal: JournalLine[];
    journalEmpty: string;
    /** A line inside the journal saying what it cannot show. */
    journalNote?: string;
  }

  let {
    title,
    titleHidden = false,
    summary,
    details,
    addPlaceholder,
    addLabel,
    inputId,
    excludeIds = [],
    onAdd,
    adding = false,
    loading,
    count,
    emptyIcon,
    emptyTitle,
    emptyDescription,
    list,
    footnote,
    journal,
    journalEmpty,
    journalNote,
  }: Props = $props();

  let picked = $state('');
  // Bumped after each add so the search field remounts empty: `UserAutocomplete` keeps its own text.
  let fieldGeneration = $state(0);

  async function submit() {
    const userId = picked.trim();
    if (!userId) {
      // Nothing picked yet: the button is never drawn disabled (it read as broken), it points at
      // the field instead.
      document.getElementById(inputId)?.focus();
      return;
    }
    await onAdd(userId);
    picked = '';
    fieldGeneration += 1;
  }

  const headingId = $derived(`${inputId}-heading`);
</script>

<section class="space-y-4" aria-labelledby={headingId}>
  <div class="space-y-1">
    <h2
      id={headingId}
      class={titleHidden ? 'sr-only' : 'text-text-main font-sans text-lg font-semibold'}
    >
      {title}
    </h2>
    <p class="text-text-muted text-sm">{summary}</p>
    <details class="group text-sm">
      <summary
        class="text-text-main inline-flex cursor-pointer list-none items-center gap-1 font-semibold underline-offset-2 hover:underline [&::-webkit-details-marker]:hidden"
      >
        {m.readaccess_learn_more()}
      </summary>
      <p class="text-text-muted mt-2">{details}</p>
    </details>
  </div>

  <form
    class="flex flex-col gap-2 sm:flex-row"
    onsubmit={(e) => {
      e.preventDefault();
      void submit();
    }}
  >
    <label for={inputId} class="sr-only">{addPlaceholder}</label>
    <div class="min-w-0 flex-1">
      {#key fieldGeneration}
        <UserAutocomplete
          value={picked}
          onValueChange={(v) => (picked = v)}
          placeholder={addPlaceholder}
          {inputId}
          {excludeIds}
          onSubmit={() => void submit()}
        />
      {/key}
    </div>
    <Button type="submit" loading={adding} class="shrink-0">
      {#if !adding}<UserPlus size={16} />{/if}
      {addLabel}
    </Button>
  </form>

  {#if loading}
    <div class="flex justify-center py-10" aria-busy="true">
      <div
        class="border-cn-yellow h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
      ></div>
    </div>
  {:else if count === 0}
    <div class="border-cn-border rounded-lg border">
      <EmptyState
        icon={emptyIcon}
        iconSize={40}
        title={emptyTitle}
        description={emptyDescription}
      />
    </div>
  {:else}
    <ul class="space-y-2">
      {@render list()}
    </ul>
  {/if}
  {#if footnote}
    <p class="text-text-muted text-xs">{footnote}</p>
  {/if}

  <details class="border-cn-border rounded-lg border" data-testid="access-journal">
    <summary class="text-text-main cursor-pointer px-4 py-3 text-sm font-semibold select-none">
      {m.readaccess_journal_summary({ count: journal.length })}
    </summary>
    <div class="border-cn-border space-y-2 border-t px-4 py-3">
      {#if journal.length === 0}
        <p class="text-text-muted text-sm">{journalEmpty}</p>
      {:else}
        <ul class="space-y-1.5 text-sm">
          {#each journal as line (line.key)}
            <li class="flex flex-col sm:flex-row sm:gap-3">
              <time class="text-text-muted shrink-0 text-xs sm:w-44 sm:text-sm" datetime={line.at}>
                {new Date(line.at).toLocaleString()}
              </time>
              <span class="text-text-main">{line.text}</span>
            </li>
          {/each}
        </ul>
      {/if}
      {#if journalNote}
        <p class="text-text-muted text-xs">{journalNote}</p>
      {/if}
    </div>
  </details>
</section>
