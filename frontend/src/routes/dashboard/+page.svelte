<script lang="ts">
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import SectionHub from '$lib/components/navigation/SectionHub.svelte';
  import { onMount } from 'svelte';
  import { clearAuth, leaveSignedOut } from '$lib/stores/auth';
  import { currentUserId, getSavedDisplayName, isGlobalAdmin } from '$lib/stores/user';
  import { ensureMyAssociations, getReviewerAccess, type Association } from '$lib/associations/api';
  import { adminScopeLabels, ensureMayOpenAdmin } from '$lib/admin/access';
  import { postNotifStore } from '$lib/stores/postNotifStore.svelte';
  import { dashboardHubGroups } from '$lib/navigation/dashboardSections';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  // THE APP'S ONE HUB (`dashboardSections.ts` is the table). The static groups render on the first
  // frame from what is already held; the manager and staff groups are appended below Explorer when
  // the membership probe answers - the probe this page already made for its admin entry.
  let mayOpenAdmin = $state(false);
  let isReviewer = $state(false);
  let memberships = $state<Association[]>([]);

  onMount(() => {
    Log.d('[dashboard] mount: probing memberships, admin tier and reviewer access');
    // Reviewer access is independent of association status (external school/MDE staff).
    void getReviewerAccess()
      .then((v) => (isReviewer = v))
      .catch((err) => {
        console.warn('[dashboard] reviewer access probe failed, Documents row hidden', err);
        isReviewer = false;
      });
    // ONE membership request, memoized: `ensureMayOpenAdmin` awaits the same promise for any
    // reader who is not a platform admin. The probe logs and answers `[]` on its own failure.
    void ensureMyAssociations().then((list) => (memberships = list));
    // The SAME predicate `/admin` admits on, so no console is offered that would refuse its reader.
    void ensureMayOpenAdmin().then((v) => (mayOpenAdmin = v));
  });

  async function signOut() {
    Log.d('[dashboard] sign-out row selected');
    await clearAuth();
    await leaveSignedOut();
  }

  const groups = $derived(
    dashboardHubGroups(
      {
        userId: currentUserId(),
        displayName: getSavedDisplayName(),
        unreadNotifications: postNotifStore.unread,
        mayOpenAdmin,
        adminScope: adminScopeLabels(isGlobalAdmin()),
        isReviewer,
        memberships,
      },
      { signOut: () => void signOut() }
    )
  );
</script>

<PageContainer>
  <PageHeader title={m.nav_dashboard_label()} subtitle={m.dashboard_subtitle()} />
  <div class="space-y-6">
    {#each groups as group (group.key)}
      <section class="space-y-2" aria-labelledby={group.heading ? `group-${group.key}` : undefined}>
        {#if group.heading}
          <h2
            id="group-{group.key}"
            class="text-text-muted scroll-mt-4 px-1 text-xs font-bold tracking-wide uppercase"
          >
            {group.label}
          </h2>
        {/if}
        <SectionHub rows={group.rows} label={group.label} />
      </section>
    {/each}
  </div>
</PageContainer>
