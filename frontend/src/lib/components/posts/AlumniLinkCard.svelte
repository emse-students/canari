<script lang="ts">
  import { seenHelps } from '$lib/guidance/seenHelps.svelte';
  import { followAlumniLinkReminder } from '$lib/profile/alumniLinkReminder.svelte';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';
  import FeedPromptCard from './FeedPromptCard.svelte';

  /**
   * THE ALUMNI LINK CARD (D44; owner, 2026-11-27: it replaces the top banner, the birthday card is the
   * better pattern - docs/wiki/profiles-and-access.md). The same quiet line as `BirthdayFeedCard`,
   * asking a signed-in person whose Alumni link is due (`alumniLinkReminderDue`) and missing to make it
   * on MiConnect's sources settings page.
   *
   * DISMISSED MEANS GONE, FROM DURABLE STATE: the cross records the help `prompt-alumni-link` in the
   * account's server-side `help_seen`, so it never returns on any device. The link action only opens
   * MiConnect and records nothing - the card leaves when the link exists (`alumniLinked` becomes true
   * at the next sign-in), and a person who went and did not finish is asked again. The way back after
   * the cross is the settings row (`SettingsAlumniLinkRow`), under the same rule, never dismissed.
   */
  const reminder = followAlumniLinkReminder();

  const visible = $derived(seenHelps.ready && !seenHelps.has('prompt-alumni-link') && reminder.due);

  $effect(() => {
    if (visible) Log.d('alumniLink', 'card shown: the Alumni link is due and missing');
  });

  function dismiss() {
    Log.d('alumniLink', 'card dismissed: recorded as seen');
    seenHelps.markSeen('prompt-alumni-link');
  }
</script>

{#if visible}
  <FeedPromptCard
    testid="alumni-link-card"
    title={m.alumni_link_card_text()}
    actionLabel={m.alumni_link_card_action()}
    onaction={reminder.open}
    ondismiss={dismiss}
  />
{/if}
