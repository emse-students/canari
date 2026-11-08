<script lang="ts">
  /**
   * THE "SUIVRE" CONTROL WHEREVER A PERSON OR AN ASSOCIATION IS NAMED (engagement WP-2): a post
   * header, a directory row, an association card. It shows only where there is something to offer -
   * never on the reader themself, a blocked account, a person already followed, or an association
   * already followed - and draws nothing while the answer is unknown, so a chip never appears and
   * then vanishes.
   *
   * A person is followed by a REQUEST (every personal account is private), so the chip flips to
   * "Demande envoyee" at once, and a tap on that withdraws it; an association is followed at once and
   * the chip then goes away. The state is `followState.svelte.ts`, shared with every other chip, and
   * the labels and refusals are the profile's (`followButton.ts`).
   */
  import { UserPlus, Send } from '@lucide/svelte';
  import { onMount } from 'svelte';
  import { m } from '$lib/paraglide/messages';
  import {
    ensureAssociationsLoaded,
    ensureBlocksLoaded,
    ensurePersonStatus,
    isAssociationFollowed,
    personChipState,
    tapAssociation,
    tapPerson,
  } from '$lib/follows/followState.svelte';
  import { followLabel } from '$lib/follows/followButton';

  interface Props {
    /** What is followed: a person, or an association (a list and an institution included). */
    kind: 'user' | 'association';
    /** The person's user id, or the association's id. */
    targetId: string;
    /** The name, for the accessible label ("Suivre X"). */
    name?: string;
  }

  let { kind, targetId, name = '' }: Props = $props();

  onMount(() => {
    if (kind === 'user') {
      ensureBlocksLoaded();
      if (targetId) ensurePersonStatus(targetId);
    } else {
      ensureAssociationsLoaded();
    }
  });

  const person = $derived(kind === 'user' ? personChipState(targetId) : undefined);
  const followed = $derived(kind === 'association' ? isAssociationFollowed(targetId) : undefined);
  /** `null` when nothing is to be drawn. */
  const shown = $derived.by<'ask' | 'pending' | null>(() => {
    if (kind === 'association') return followed === false ? 'ask' : null;
    if (person === 'pending') return 'pending';
    return person === null ? 'ask' : null;
  });
  const label = $derived(
    shown === 'pending'
      ? followLabel('pending')
      : name
        ? m.follow_chip_follow_named({ name })
        : followLabel(null)
  );

  function onTap(e: Event) {
    // The chip sits beside links and inside cards: a tap on it is never a tap on them.
    e.preventDefault();
    e.stopPropagation();
    if (kind === 'user') void tapPerson(targetId);
    else void tapAssociation(targetId);
  }
</script>

{#if shown}
  <button
    type="button"
    onclick={onTap}
    aria-label={label}
    data-follow-chip={kind}
    data-follow-chip-state={shown}
    class="focus-visible:ring-cn-yellow/50 inline-flex shrink-0 items-center gap-1 rounded-full px-3 py-1 text-xs font-bold transition-all outline-none focus-visible:ring-2 active:scale-95 {shown ===
    'pending'
      ? 'border-cn-border text-text-muted border'
      : 'bg-cn-yellow text-cn-ink'}"
  >
    {#if shown === 'pending'}
      <Send size={12} strokeWidth={2.5} aria-hidden="true" />
    {:else}
      <UserPlus size={12} strokeWidth={2.5} aria-hidden="true" />
    {/if}
    <span>{shown === 'pending' ? followLabel('pending') : followLabel(null)}</span>
  </button>
{/if}
