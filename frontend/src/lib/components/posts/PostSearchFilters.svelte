<script lang="ts">
  import { X, User, Building2 } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import UserAutocomplete from '$lib/components/shared/UserAutocomplete.svelte';
  import { listAssociationDirectory, type Association } from '$lib/associations/api';
  import { matchAssociations } from '$lib/posts/postSearchFilters';
  import type { PostSearchPick } from '$lib/posts/postSearchFilters';

  /**
   * THE POST SEARCH'S TWO FILTERS (owner, 2026-11-19): a person and an association, combinable with
   * the words typed above. Each is a chip once chosen and removable by its own button. A filter only
   * narrows what the reader may already see (the server's audience rules are unchanged).
   */
  interface Props {
    author: PostSearchPick | null;
    association: PostSearchPick | null;
    onAuthor: (pick: PostSearchPick | null) => void;
    onAssociation: (pick: PostSearchPick | null) => void;
  }

  let { author, association, onAuthor, onAssociation }: Props = $props();

  /** Which picker is open, if any: at most one, so the row never grows two search fields. */
  let open = $state<'author' | 'association' | null>(null);
  let assoQuery = $state('');
  let directory = $state<Association[]>([]);
  let directoryLoaded = false;

  const assoMatches = $derived(matchAssociations(directory, assoQuery));

  async function openPicker(which: 'author' | 'association') {
    open = open === which ? null : which;
    if (which !== 'association' || open !== 'association' || directoryLoaded) return;
    try {
      directory = await listAssociationDirectory();
      directoryLoaded = true;
    } catch (err) {
      // The picker stays empty: the reader sees "no result" and can type the name in the search
      // field instead, which still matches association names.
      Log.w('POSTS', `post search: the association directory could not be read: ${String(err)}`);
    }
  }

  function pickAssociation(a: Association) {
    onAssociation({ id: a.id, name: a.name });
    open = null;
    assoQuery = '';
  }

  const chipClass =
    'text-text-main bg-accent/10 inline-flex max-w-full items-center gap-1.5 rounded-full py-0.5 pr-1 pl-3 text-xs font-semibold';
</script>

<div class="mt-2 flex flex-wrap items-center gap-2" data-post-search-filters>
  {#if author}
    <span class={chipClass}>
      <User size={12} aria-hidden="true" />
      <span class="truncate">{author.name}</span>
      <Button
        variant="bare"
        class="tap-target hover:text-red-err"
        aria-label={m.posts_search_filter_remove_aria({ name: author.name })}
        onclick={() => onAuthor(null)}
      >
        <X size={14} />
      </Button>
    </span>
  {:else}
    <Button
      variant="secondary"
      size="compact"
      class="rounded-full"
      aria-expanded={open === 'author'}
      onclick={() => openPicker('author')}
    >
      <User size={12} aria-hidden="true" />
      {m.posts_search_filter_author()}
    </Button>
  {/if}

  {#if association}
    <span class={chipClass}>
      <Building2 size={12} aria-hidden="true" />
      <span class="truncate">{association.name}</span>
      <Button
        variant="bare"
        class="tap-target hover:text-red-err"
        aria-label={m.posts_search_filter_remove_aria({ name: association.name })}
        onclick={() => onAssociation(null)}
      >
        <X size={14} />
      </Button>
    </span>
  {:else}
    <Button
      variant="secondary"
      size="compact"
      class="rounded-full"
      aria-expanded={open === 'association'}
      onclick={() => openPicker('association')}
    >
      <Building2 size={12} aria-hidden="true" />
      {m.posts_search_filter_association()}
    </Button>
  {/if}
</div>

{#if open === 'author' && !author}
  <div class="mt-2" data-post-search-author-picker>
    <UserAutocomplete
      value=""
      inputId="post-search-author"
      placeholder={m.posts_search_filter_author_placeholder()}
      clearOnSelect
      onValueChange={() => {}}
      onSelect={(user) => {
        onAuthor({ id: user.id, name: user.displayName || user.id });
        open = null;
      }}
    />
  </div>
{:else if open === 'association' && !association}
  <div class="mt-2" data-post-search-association-picker>
    <Input
      type="search"
      bind:value={assoQuery}
      placeholder={m.posts_search_filter_association_placeholder()}
    />
    <ul class="border-cn-border bg-cn-surface mt-1 max-h-56 overflow-y-auto rounded-2xl border">
      {#each assoMatches as a (a.id)}
        <li>
          <Button
            variant="ghost"
            class="w-full justify-start text-left"
            onclick={() => pickAssociation(a)}>{a.name}</Button
          >
        </li>
      {:else}
        <li class="text-text-muted px-3.5 py-2 text-sm">{m.posts_search_filter_none()}</li>
      {/each}
    </ul>
  </div>
{/if}
