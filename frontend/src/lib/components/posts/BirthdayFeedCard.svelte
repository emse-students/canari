<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { X } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
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
  <div
    class="border-cn-border bg-cn-surface mb-4 flex items-center gap-2 rounded-2xl border py-2 pr-2 pl-4"
    data-testid="birthday-feed-card"
  >
    <p class="text-text-main min-w-0 flex-1 text-sm font-medium">{m.birthday_card_title()}</p>
    <Button variant="secondary" size="compact" onclick={add}>{m.birthday_card_action()}</Button>
    <Button
      variant="ghost"
      size="compact"
      icon
      aria-label={m.common_close_label()}
      onclick={() => dismiss('dismissed')}
    >
      <X size={16} />
    </Button>
  </div>
{/if}
