<script lang="ts">
  import { Link2 } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { followAlumniLinkReminder } from '$lib/profile/alumniLinkReminder.svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE PERMANENT WAY BACK TO THE ALUMNI LINK (D44, docs/wiki/profiles-and-access.md): the feed card's
   * cross is remembered for good, so this row stays under the SAME rule (`alumniLinkReminderDue`) and
   * ignores the dismissal. It leaves once the link exists. Same row shape as the rest of the security
   * section.
   */
  const reminder = followAlumniLinkReminder();
</script>

{#if reminder.due}
  <div
    class="bg-cn-surface flex items-center justify-between gap-4 rounded-2xl border border-black/5 p-4 shadow-sm dark:border-white/5"
    data-testid="settings-alumni-link-row"
  >
    <div class="flex min-w-0 items-center gap-3.5">
      <div class="text-text-muted shrink-0 rounded-xl bg-black/5 p-2.5 dark:bg-black/40">
        <Link2 size={20} strokeWidth={2.5} />
      </div>
      <div class="min-w-0">
        <p class="text-text-main text-sm font-bold">{m.settings_alumni_link_heading()}</p>
        <p class="text-text-muted mt-0.5 text-xs font-medium">{m.settings_alumni_link_desc()}</p>
      </div>
    </div>
    <Button variant="secondary" size="compact" class="shrink-0" onclick={() => reminder.open()}>
      {m.alumni_link_card_action()}
    </Button>
  </div>
{/if}
