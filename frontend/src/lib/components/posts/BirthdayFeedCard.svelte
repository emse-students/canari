<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import FeedPromptCard from './FeedPromptCard.svelte';
  import { ownBirthday } from '$lib/birthdays/birthdaysToday.svelte';
  import { seenHelps } from '$lib/guidance/seenHelps.svelte';
  import { profileSectionHref } from '$lib/profile/profileSections';
  import { internalPath } from '$lib/utils/internalPath';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

  /**
   * THE BIRTHDAY CARD (owner, 2026-11-10; docs/wiki/birthdays.md): a small, quiet line at the top of
   * the feed for an account the server says has NO birthday - "Ton anniversaire ?", an "Ajouter"
   * action and a cross. It replaced the self-opening modal of 1.6.9, which was too insistent and
   * whose button overflowed a phone.
   *
   * DISMISSED MEANS GONE, FROM DURABLE STATE, NEVER A TIMER: the cross and "Ajouter" both record the
   * help `prompt-birthday` in the account's server-side `help_seen` (the profile-photo prompt's
   * store), so the card does not return on any device. It shows only once both facts are KNOWN -
   * `seenHelps.ready` and `ownBirthday.hasBirthday === false` - from the server, or since 2026-11-11
   * from the device's copy of an earlier server answer (drawn before the session refresh, then
   * revalidated: the card leaves if the answer says otherwise). A device that never had an answer
   * shows NOTHING rather than a card that would come back.
   */
  const visible = $derived(
    seenHelps.ready && !seenHelps.has('prompt-birthday') && ownBirthday.hasBirthday === false
  );

  function dismiss(reason: 'dismissed' | 'add') {
    Log.d('birthdays', `feed card ${reason}: recorded as seen`);
    seenHelps.markSeen('prompt-birthday');
  }

  function add() {
    dismiss('add');
    void goto(resolve(internalPath(profileSectionHref('birthday'))));
  }
</script>

{#if visible}
  <FeedPromptCard
    testid="birthday-feed-card"
    title={m.birthday_card_title()}
    actionLabel={m.birthday_card_action()}
    onaction={add}
    ondismiss={() => dismiss('dismissed')}
  />
{/if}
