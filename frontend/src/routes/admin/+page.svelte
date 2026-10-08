<script lang="ts">
  import { onMount } from 'svelte';
  import {
    isGlobalAdmin,
    isAssociationSuperAdmin,
    isContentModerator,
    isEventValidator,
  } from '$lib/stores/user';
  import {
    listPendingCalendarEvents,
    ensureAssociationSuperAdmin,
    ensureContentModerator,
    ensureEventValidator,
  } from '$lib/associations/api';
  import SectionHub from '$lib/components/navigation/SectionHub.svelte';
  import { adminHubGroups, type AdminTiers } from '$lib/admin/adminSections';
  import { m } from '$lib/paraglide/messages';

  let isGlobalAdminUser = $state(false);
  let isSuperAdminUser = $state(false);
  let isModeratorUser = $state(false);
  let isEventValidatorUser = $state(false);
  let pendingCount = $state<number | null>(null);

  async function loadPendingCount() {
    if (!isEventValidatorUser) return;
    try {
      const pending = await listPendingCalendarEvents();
      pendingCount = pending.events.length;
    } catch {
      pendingCount = null;
    }
  }

  onMount(async () => {
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
        void loadPendingCount();
      });
    }
    await loadPendingCount();
  });

  const tiers = $derived<AdminTiers>({
    isGlobalAdmin: isGlobalAdminUser,
    isSuperAdmin: isSuperAdminUser,
    isModerator: isModeratorUser,
    isEventValidator: isEventValidatorUser,
  });

  // The rows are the registry's, filtered by tier - the layout's guard reads the SAME table. The
  // pending count is the one live number a row carries, in place of the old card badge.
  const groups = $derived(
    adminHubGroups(
      tiers,
      pendingCount !== null && pendingCount > 0
        ? { agenda: m.admin_hub_pending_count({ count: pendingCount }) }
        : {}
    )
  );
</script>

<div class="space-y-6">
  {#each groups as group (group.key)}
    <section class="space-y-2" aria-labelledby="group-{group.key}">
      <h2
        id="group-{group.key}"
        class="text-text-muted scroll-mt-4 px-1 text-xs font-bold tracking-wide uppercase"
      >
        {group.label}
      </h2>
      <SectionHub rows={group.rows} label={group.label} />
    </section>
  {/each}

  <p class="text-text-muted text-xs">
    {m.admin_payments_connect_hint()}
  </p>
</div>
