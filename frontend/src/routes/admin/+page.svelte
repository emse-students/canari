<script lang="ts">
  import { onMount } from 'svelte';
  import {
    isGlobalAdmin,
    isAssociationSuperAdmin,
    isContentModerator,
    isEventValidator,
  } from '$lib/stores/user';
  import {
    ensureAssociationSuperAdmin,
    ensureContentModerator,
    ensureEventValidator,
  } from '$lib/associations/api';
  import SectionHub from '$lib/components/navigation/SectionHub.svelte';
  import { adminHubGroups, type AdminTiers } from '$lib/admin/adminSections';
  import { adminQueueCounts, loadAdminQueueCounts } from '$lib/admin/adminQueueCounts.svelte';
  import { m } from '$lib/paraglide/messages';

  let isGlobalAdminUser = $state(false);
  let isSuperAdminUser = $state(false);
  let isModeratorUser = $state(false);
  let isEventValidatorUser = $state(false);

  onMount(() => {
    // The hub is where an admin looks for what waits: asked afresh on every open.
    void loadAdminQueueCounts();
    isGlobalAdminUser = isGlobalAdmin();
    isSuperAdminUser = isGlobalAdminUser || isAssociationSuperAdmin();
    isModeratorUser = isGlobalAdminUser || isContentModerator();
    isEventValidatorUser = isGlobalAdminUser || isEventValidator();
    // Both tiers resolve from ONE membership request, already warm if the layout asked first.
    if (!isGlobalAdminUser) {
      void Promise.all([
        ensureAssociationSuperAdmin(),
        ensureContentModerator(),
        ensureEventValidator(),
      ]).then(([superAdmin, moderator, eventValidator]) => {
        isSuperAdminUser = superAdmin;
        isModeratorUser = moderator;
        isEventValidatorUser = eventValidator;
      });
    }
  });

  const tiers = $derived<AdminTiers>({
    isGlobalAdmin: isGlobalAdminUser,
    isSuperAdmin: isSuperAdminUser,
    isModerator: isModeratorUser,
    isEventValidator: isEventValidatorUser,
  });

  // The rows are the registry's, filtered by tier - the layout's guard reads the SAME table. Each
  // queue row carries the server's pending count for THIS reader (`adminQueueCounts`): the agenda
  // counts only the events they may validate, which the old client-side count did not.
  const groups = $derived(adminHubGroups(tiers, adminQueueCounts.counts));
</script>

<div class="space-y-6">
  {#each groups as group (group.key)}
    <section class="space-y-2" aria-labelledby="group-{group.key}">
      <h2 id="group-{group.key}" class="text-text-muted scroll-mt-4 px-1 text-xs font-bold">
        {group.label}
      </h2>
      <SectionHub rows={group.rows} label={group.label} />
    </section>
  {/each}

  <p class="text-text-muted text-xs">
    {m.admin_payments_connect_hint()}
  </p>
</div>
