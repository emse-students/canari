<script lang="ts">
  import { currentUserId, fetchMyProfile, type UserProfile } from '$lib/stores/user';
  import { authentikUrl } from '$lib/stores/auth';
  import { seenHelps } from '$lib/guidance/seenHelps.svelte';
  import { alumniLinkReminderDue, miconnectSourcesSettingsUrl } from '$lib/profile/alumniLink';
  import { openExternal } from '$lib/utils/openExternal';
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
   * account's server-side `help_seen`, so it never returns on any device. "Lier" only opens MiConnect
   * and records nothing - the card leaves when the link exists (`alumniLinked` becomes true at the next
   * sign-in), and a person who went and did not finish is asked again. An unknown link
   * (`alumniLinked` absent) shows nothing. It reads the reader's OWN profile (cached, shared with every
   * other caller).
   */
  let profile = $state<UserProfile | null>(null);
  const target = miconnectSourcesSettingsUrl(authentikUrl());

  $effect(() => {
    const id = currentUserId();
    profile = null;
    if (!id || !target) return;
    let live = true;
    fetchMyProfile()
      .then((p) => {
        if (live) profile = p;
      })
      .catch((err) => Log.d('alumniLink', 'own profile not read, no reminder', err));
    return () => {
      live = false;
    };
  });

  const visible = $derived(
    seenHelps.ready &&
      !seenHelps.has('prompt-alumni-link') &&
      !!target &&
      !!profile &&
      alumniLinkReminderDue(profile, new Date())
  );

  $effect(() => {
    if (visible) Log.d('alumniLink', 'card shown: the Alumni link is due and missing');
  });

  function link() {
    Log.d('alumniLink', 'link tapped');
    if (target) void openExternal(target);
  }

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
    onaction={link}
    ondismiss={dismiss}
  />
{/if}
