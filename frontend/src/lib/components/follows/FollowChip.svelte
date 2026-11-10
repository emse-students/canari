<script lang="ts">
  /**
   * THE "SUIVRE" CONTROL WHEREVER A PERSON OR AN ASSOCIATION IS NAMED (engagement WP-2): a post
   * header, a directory row, an association card. It shows only where there is something to offer -
   * never on the reader themself, a blocked account, a person already followed or requested, or an
   * association already followed, archived, or one the reader belongs to - and draws nothing while
   * the answer is unknown, so a chip never appears and then vanishes.
   *
   * QUIET BY RULE (owner, 2026-11-10: "Suivre agresse trop"): `link` (the default) is a bare accent
   * TEXT, no fill and no icon, meant for a meta line ("19 h . Suggestion . Suivre", "7 membres .
   * Suivre"); `soft` is a neutral secondary button, for the suggestion cards only. Solid yellow stays
   * the primary action of a screen. A tap follows at once - a REQUEST for a person (every personal
   * account is private), a follow for an association - and the control then GOES AWAY, a toast
   * saying what happened (`followState.svelte.ts`, which every chip shares); a request is withdrawn
   * from the profile or the sent-requests list, not from here.
   */
  import { beforeNavigate } from '$app/navigation';
  import Button from '$lib/components/ui/Button.svelte';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';
  import { showToast } from '$lib/stores/toast.svelte';
  import {
    ensureAssociationsLoaded,
    ensureBlocksLoaded,
    followEpoch,
    retryFailedFollowReads,
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
    /** The name, for the accessible label ("Suivre X"). */
    name?: string;
    /** An archived association is not offered (a closed association has nothing to follow for). */
    archived?: boolean;
    /** `link`: a bare accent text on a meta line. `soft`: a neutral secondary button (suggestion cards). */
    variant?: 'link' | 'soft';
    /** Called once after a tap the server accepted - a suggestion card uses it to leave and be replaced. */
    onFollowed?: () => void;
    /** Draws a leading middot WITH the link, so a link that is not drawn leaves no orphan separator. */
    dotted?: boolean;
  }

  let {
    kind,
    targetId,
    name = '',
    archived = false,
    variant = 'link',
    onFollowed,
    dotted = false,
  }: Props = $props();

  // A real navigation asks again, once, for what failed (an online 5xx no reconnect ever heals).
  beforeNavigate(() => retryFailedFollowReads());

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

  /** Drawn only where there is something to ask: a request already sent draws nothing. */
  const shown = $derived(
    kind === 'association' ? !archived && association === false : person === null
  );
  /** The accessible name CONTAINS the visible text (label in name): "Suivre X" for "Suivre". */
  const label = $derived(name ? m.follow_chip_follow_named({ name }) : followLabel(null));

  async function onTap(e: Event) {
    // The chip sits beside links and inside cards: a tap on it is never a tap on them.
    e.preventDefault();
    e.stopPropagation();
    const status =
      kind === 'user'
        ? await tapPerson(targetId)
        : (await tapAssociation(targetId))
          ? 'accepted'
          : null;
    if (!status) return;
    // The confirmation says what the SERVER answered: a request for a private account, a follow for
    // one that took it at once (tapPerson hands the status back; an association is always a follow).
    const requested = status === 'pending';
    Log.d(
      'FollowChip',
      `${kind} ${targetId.slice(0, 8)} -> ${requested ? 'requested' : 'following'}`
    );
    showToast(
      name
        ? requested
          ? m.follow_toast_requested_named({ name })
          : m.follow_toast_following_named({ name })
        : followLabel(requested ? 'pending' : 'accepted'),
      'info'
    );
    onFollowed?.();
  }
</script>

{#if shown}
  {#if variant === 'soft'}
    <Button
      size="compact"
      variant="soft"
      onclick={onTap}
      aria-label={label}
      class="relative before:absolute before:-inset-1.5 before:content-['']"
      data-follow-chip={kind}
      data-follow-chip-state="ask"
      data-follow-chip-variant="soft"
    >
      {followLabel(null)}
    </Button>
  {:else}
    <!-- The dot and the link are ONE unit, so they never split across a wrapped line. -->
    <span class="inline-flex shrink-0 items-center gap-1.5">
      {#if dotted}<span aria-hidden="true">&#183;</span>{/if}
      <Button
        variant="link"
        onclick={onTap}
        aria-label={label}
        class="shrink-0"
        data-follow-chip={kind}
        data-follow-chip-state="ask"
        data-follow-chip-variant="link"
      >
        {followLabel(null)}
      </Button>
    </span>
  {/if}
{/if}
