<script lang="ts">
  import { CARD_GRID } from '$lib/components/layout/cardGrid';
  import AssociationTile from '$lib/components/associations/AssociationTile.svelte';
  import type { Association } from '$lib/associations/api';

  /**
   * The "Mes ..." block on top of a directory tab: the reader's own memberships of ONE kind,
   * pinned above the directory (which still lists them, badged). Drawn only when there is one, so
   * a reader belonging to none sees the directory alone.
   */
  let {
    heading,
    items,
    href,
  }: { heading: string; items: Association[]; href: (a: Association) => string } = $props();
</script>

{#if items.length > 0}
  <section data-testid="my-memberships">
    <h2 class="text-text-main mb-3 text-base font-bold">{heading}</h2>
    <div class={CARD_GRID}>
      {#each items as asso (asso.id)}
        <AssociationTile association={asso} href={href(asso)} isMember />
      {/each}
    </div>
  </section>
{/if}
