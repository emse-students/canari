<script lang="ts">
  /**
   * ONE RESULT OF THE UNIVERSAL SEARCH, whatever its section: a face or a logo or the section's icon,
   * the title, a grey line, and for a message the words around the match with the typed words marked.
   * A link when the result is a page, a button when it opens something in place (a conversation, an
   * event's sheet). `data-search-hit` is what the arrow keys walk (`UniversalSearch.svelte`).
   */
  import type { Component } from 'svelte';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import type { SearchHit } from '$lib/search/types';

  interface Props {
    hit: SearchHit;
    /** The section's icon, drawn when the hit has no face and no logo. */
    icon: Component<{ size?: number }>;
    /** Called once the hit was followed, so the search can close behind it. */
    onFollowed?: () => void;
  }

  let { hit, icon: Icon, onFollowed }: Props = $props();

  /** The snippet cut into plain and marked pieces, in order. */
  const pieces = $derived.by(() => {
    if (!hit.snippet) return [];
    const out: { text: string; marked: boolean }[] = [];
    let at = 0;
    for (const [a, b] of hit.snippet.ranges) {
      if (a > at) out.push({ text: hit.snippet.text.slice(at, a), marked: false });
      out.push({ text: hit.snippet.text.slice(a, b), marked: true });
      at = b;
    }
    if (at < hit.snippet.text.length) out.push({ text: hit.snippet.text.slice(at), marked: false });
    return out;
  });

  function follow() {
    hit.open?.();
    onFollowed?.();
  }
</script>

{#snippet body()}
  <span class="h-10 w-10 shrink-0" aria-hidden="true">
    {#if hit.avatarUserId}
      <Avatar userId={hit.avatarUserId} fill shape="circle" />
    {:else if hit.imageUrl !== undefined}
      <AssociationAvatar id={hit.key} name={hit.title} logoUrl={hit.imageUrl} fill />
    {:else}
      <span
        class="bg-cn-surface-alt text-text-muted flex h-full w-full items-center justify-center rounded-full"
      >
        <Icon size={18} />
      </span>
    {/if}
  </span>
  <span class="min-w-0 flex-1 text-left">
    <span class="text-text-main block truncate text-sm font-semibold">{hit.title}</span>
    {#if hit.snippet}
      <span class="text-text-main line-clamp-2 block text-xs" data-search-snippet>
        {#each pieces as piece, i (i)}
          {#if piece.marked}<mark class="bg-accent/30 text-text-main rounded-sm">{piece.text}</mark
            >{:else}{piece.text}{/if}
        {/each}
      </span>
    {/if}
    {#if hit.subtitle}
      <span class="text-text-muted block truncate text-xs">{hit.subtitle}</span>
    {/if}
  </span>
{/snippet}

<li>
  {#if hit.href}
    <a
      href={hit.href}
      data-search-hit
      onclick={() => onFollowed?.()}
      class="hover:bg-cn-surface-alt focus-visible:outline-accent-icon flex min-w-0 items-center gap-3 rounded-xl px-2 py-2 focus-visible:outline-2"
    >
      {@render body()}
    </a>
  {:else}
    <Button
      variant="bare"
      data-search-hit
      onclick={follow}
      class="hover:bg-cn-surface-alt flex w-full min-w-0 items-center gap-3 rounded-xl px-2 py-2"
    >
      {@render body()}
    </Button>
  {/if}
</li>
