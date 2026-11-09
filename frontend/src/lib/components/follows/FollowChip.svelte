<script lang="ts">
  /**
   * THE "SUIVRE" CONTROL WHEREVER A PERSON OR AN ASSOCIATION IS NAMED (engagement WP-2): a post
   * header, a directory row, an association card. It shows only where there is something to offer -
   * never on the reader themself, a blocked account, a person already followed, or an association
   * already followed, archived, or one the reader belongs to - and draws nothing while the answer is unknown, so a chip never appears and
   * then vanishes.
   *
   * A person is followed by a REQUEST (every personal account is private), so the chip flips to
   * "Demande envoyee" at once, and a tap on that withdraws it; an association is followed at once and
   * the chip then goes away. The state is `followState.svelte.ts`, shared with every other chip, and
   * the labels and refusals are the profile's (`followButton.ts`).
   */
  import { UserPlus, Send } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { m } from '$lib/paraglide/messages';
  import {
    ensureAssociationsLoaded,
    ensureBlocksLoaded,
    followEpoch,
    ensurePersonStatus,
    associationChipState,
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
    /** The name, for the accessible label ("Suivre X", "Retirer la demande de suivi a X"). */
    name?: string;
    /** An archived association is not offered (a closed association has nothing to follow for). */
    archived?: boolean;
    /** Only the glyph below the `sm` breakpoint (the label stays the accessible name): a post header shares its row with the author's name and up to five action buttons. */
    iconOnlyOnPhone?: boolean;
  }

  let { kind, targetId, name = '', archived = false, iconOnlyOnPhone = false }: Props = $props();

  const person = $derived(kind === 'user' ? personChipState(targetId) : undefined);
  const association = $derived(kind === 'association' ? associationChipState(targetId) : undefined);

  // An effect and not a mount hook: a block drops what the ledger read, the answer turns unknown
  // again and this chip asks again - one more id in the next batch.
  $effect(() => {
    followEpoch();
    if (kind === 'user') {
      ensureBlocksLoaded();
      if (targetId && person === undefined) ensurePersonStatus(targetId);
    } else if (association === undefined) {
      ensureAssociationsLoaded();
    }
  });

  /** `null` when nothing is to be drawn. */
  const shown = $derived.by<'ask' | 'pending' | null>(() => {
    if (kind === 'association') return !archived && association === false ? 'ask' : null;
    if (person === 'pending') return 'pending';
    return person === null ? 'ask' : null;
  });
  const label = $derived(
    shown === 'pending'
      ? m.follow_chip_withdraw_named({ name: name || followLabel('pending') })
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
  <Button
    size="compact"
    variant={shown === 'pending' ? 'secondary' : 'primary'}
    onclick={onTap}
    aria-label={label}
    class="relative before:absolute before:-inset-1.5 before:content-['']"
    data-follow-chip={kind}
    data-follow-chip-state={shown}
  >
    {#if shown === 'pending'}
      <Send size={12} strokeWidth={2.5} aria-hidden="true" />
    {:else}
      <UserPlus size={12} strokeWidth={2.5} aria-hidden="true" />
    {/if}
    <span class={iconOnlyOnPhone ? 'max-sm:hidden' : ''}
      >{shown === 'pending' ? followLabel('pending') : followLabel(null)}</span
    >
  </Button>
{/if}
