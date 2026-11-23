<script lang="ts" module>
  /**
   * Dismissed for the rest of this run of the app (D44: "dismissible per session"). Module state,
   * not storage: it outlives a navigation, and a restart - a new session - reminds again. The
   * reminder is skippable by design; MiConnect's own stage is what blocks, from 1 February P+2.
   */
  let dismissed = $state(false);
</script>

<script lang="ts">
  import { Link2, X } from '@lucide/svelte';
  import { currentUserId, fetchMyProfile, type UserProfile } from '$lib/stores/user';
  import { authentikUrl } from '$lib/stores/auth';
  import { alumniLinkReminderDue, miconnectSourcesSettingsUrl } from '$lib/profile/alumniLink';
  import { openExternal } from '$lib/utils/openExternal';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';
  import Banner from './Banner.svelte';
  import Button from '$lib/components/ui/Button.svelte';

  /**
   * Asks a signed-in person whose Alumni link is due (D44) and missing to make it, on MiConnect's
   * sources settings page. It reads the reader's OWN profile (cached, shared with every other
   * caller) and decides through `alumniLinkReminderDue`; an unknown link (`alumniLinked` absent)
   * shows nothing.
   */
  let profile = $state<UserProfile | null>(null);
  const target = miconnectSourcesSettingsUrl(authentikUrl());

  $effect(() => {
    const id = currentUserId();
    profile = null;
    if (!id || dismissed || !target) return;
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

  const due = $derived(
    !dismissed && !!target && !!profile && alumniLinkReminderDue(profile, new Date())
  );

  $effect(() => {
    if (due) Log.d('alumniLink', 'reminder shown: the Alumni link is due and missing');
  });

  function link() {
    Log.d('alumniLink', 'link tapped');
    if (target) void openExternal(target);
  }
</script>

{#if due}
  <Banner variant="info">
    <Link2 size={14} class="shrink-0" aria-hidden="true" />
    <span class="min-w-0 flex-1 truncate">{m.alumni_link_banner_text()}</span>
    {#snippet action()}
      <span class="flex shrink-0 gap-1">
        <Button variant="bare" class="banner-action font-bold underline" onclick={link}>
          {m.alumni_link_banner_action()}
        </Button>
        <Button
          variant="bare"
          class="banner-action"
          aria-label={m.alumni_link_banner_dismiss()}
          title={m.alumni_link_banner_dismiss()}
          onclick={() => {
            Log.d('alumniLink', 'reminder dismissed for this session');
            dismissed = true;
          }}
        >
          <X size={14} aria-hidden="true" />
        </Button>
      </span>
    {/snippet}
  </Banner>
{/if}
