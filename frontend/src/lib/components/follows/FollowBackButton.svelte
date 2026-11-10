<script lang="ts">
  /**
   * "SUIVRE EN RETOUR" (owner, 2026-11-09): after the reader accepts a follow request, the row offers
   * the follow in the other direction, Instagram-style. It reuses the WP-2 ledger (`followState`): the
   * tap is {@link tapPerson} - a REQUEST, since every personal account is private - and the button
   * then reads "Demande envoyee" (a tap withdraws it) or "Abonne". Nothing is drawn for the reader,
   * a blocked account, or a pair already pending or following when the row was accepted.
   */
  import { UserPlus, Send, Check } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { m } from '$lib/paraglide/messages';
  import {
    ensureBlocksLoaded,
    ensurePersonStatus,
    followEpoch,
    personChipState,
    tapPerson,
  } from '$lib/follows/followState.svelte';
  import { followBackView, followLabel } from '$lib/follows/followButton';

  interface Props {
    /** The person just accepted. */
    userId: string;
    /** Their name, for the accessible label. */
    name?: string;
  }

  let { userId, name = '' }: Props = $props();

  const status = $derived(personChipState(userId));
  /** Latched once the offer was drawn: from then on the answer to the tap stays on screen. */
  let offered = $state(false);
  const view = $derived(followBackView(status, offered));

  $effect(() => {
    followEpoch();
    ensureBlocksLoaded();
    if (userId && status === undefined) ensurePersonStatus(userId);
  });
  $effect(() => {
    if (view === 'follow_back') offered = true;
  });

  const label = $derived(
    view === 'requested'
      ? name
        ? m.follow_chip_withdraw_named({ name })
        : m.follow_chip_withdraw()
      : name
        ? m.follow_back_named({ name })
        : m.follow_back_btn()
  );
</script>

{#if view}
  <Button
    size="compact"
    variant={view === 'follow_back' ? 'primary' : 'secondary'}
    onclick={() => void tapPerson(userId)}
    disabled={view === 'following'}
    aria-label={view === 'following' ? followLabel('accepted') : label}
    data-follow-back={view}
  >
    {#if view === 'follow_back'}
      <UserPlus size={12} strokeWidth={2.5} aria-hidden="true" />
      <span>{m.follow_back_btn()}</span>
    {:else if view === 'requested'}
      <Send size={12} strokeWidth={2.5} aria-hidden="true" />
      <span>{followLabel('pending')}</span>
    {:else}
      <Check size={12} strokeWidth={2.5} aria-hidden="true" />
      <span>{followLabel('accepted')}</span>
    {/if}
  </Button>
{/if}
