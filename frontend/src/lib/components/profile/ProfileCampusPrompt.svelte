<script lang="ts">
  /**
   * The profile-completion prompt of the audiences chantier (decision 5, user 2026-10-07): the
   * presets of an audience are computed from a CAMPUS, so a manager whose profile has none completes
   * the profile first. A campus is MiConnect's and only an admin edits it, so completing it means
   * the existing correction request - reused here rather than rebuilt - and the profile page that
   * carries it.
   */
  import { resolve } from '$app/paths';
  import { MapPinOff } from '@lucide/svelte';
  import ProfileCorrectionRequest from '$lib/components/profile/ProfileCorrectionRequest.svelte';
  import { m } from '$lib/paraglide/messages';
</script>

<div
  class="border-cn-border bg-cn-surface space-y-3 rounded-2xl border p-6"
  role="status"
  data-audience-profile-prompt
>
  <h2 class="text-text-main flex items-center gap-2 text-lg font-bold tracking-tight">
    <MapPinOff size={20} />
    {m.audience_profile_prompt_title()}
  </h2>
  <p class="text-text-muted text-sm">{m.audience_profile_prompt_body()}</p>
  <ProfileCorrectionRequest />
  <a
    href={resolve('/profile')}
    class="text-text-main inline-block text-sm font-bold underline underline-offset-2"
  >
    {m.audience_profile_prompt_link()}
  </a>
</div>
