<script lang="ts">
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import {
    organisersFullList,
    splitOrganiserFaces,
    type EventOwnerIdentity,
  } from '$lib/calendar/feedEvents';

  /**
   * THE FACES OF THE ASSOCIATIONS RUNNING ONE EVENT, OVERLAPPED IN A STACK.
   *
   * An event may have up to four organising associations (D39, 2026-10-10), and the agenda rows
   * drew ONLY the organiser's logo next to a " + "-joined line of names that truncated: a reader of a
   * four-association evening saw one logo and two names. The stack draws at most three circular
   * faces, each ringed in the surface colour so the overlap reads as separate discs, then a `+N`
   * pill for the rest. It is the same `AssociationAvatar` everywhere else uses, so a logo that
   * fails to load falls back to initials here too.
   *
   * The stack is a picture of what the label beside it says, so it is one `role="img"` carrying the
   * FULL list - the label itself stops at "A + N others" - and the same list as its title.
   */
  interface Props {
    owners: EventOwnerIdentity[];
    /** `sm` (24 px) in the dense agenda rows, `md` (32 px) in the day panel. */
    size?: 'sm' | 'md';
  }

  let { owners, size = 'sm' }: Props = $props();

  const faces = $derived(splitOrganiserFaces(owners));
  const fullList = $derived(organisersFullList(owners));
  const pillSize = $derived(size === 'md' ? 'h-8 w-8' : 'h-6 w-6');
</script>

<span class="inline-flex shrink-0 items-center" role="img" aria-label={fullList} title={fullList}>
  {#each faces.shown as owner, i (owner.associationId)}
    <span class="ring-cn-surface rounded-full ring-2 {i > 0 ? '-ml-2' : ''}">
      <AssociationAvatar name={owner.name} logoUrl={owner.logoUrl} {size} shape="circle" />
    </span>
  {/each}
  {#if faces.hidden.length > 0}
    <span
      class="ring-cn-surface bg-cn-surface-alt text-text-muted text-2xs -ml-2 flex shrink-0 items-center justify-center rounded-full font-bold ring-2 {pillSize}"
      data-organiser-more={faces.hidden.length}
    >
      +{faces.hidden.length}
    </span>
  {/if}
</span>
