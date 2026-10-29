<script lang="ts">
  /**
   * `/admin/read-access`: two unrelated access lists, one tab each, drawn by ONE template
   * (`AccessSection`) - see the admin wiki page, "Read access".
   *
   * The named readers are a global admin's alone (D24); a BDE super-admin reaches this page for the
   * document reviewers only, so they get that list with no tab bar above it.
   */
  import { resolve } from '$app/paths';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { Eye, FileCheckCorner } from '@lucide/svelte';
  import { Log } from '$lib/utils/Log';
  import { isGlobalAdmin, isAssociationSuperAdmin } from '$lib/stores/user';
  import { ensureAssociationSuperAdmin } from '$lib/associations/api';
  import { parseTab, tabUrl } from '$lib/navigation/tabQuery';
  import { internalPath } from '$lib/utils/internalPath';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
  import ReadAccessPanel from '$lib/components/admin/access/ReadAccessPanel.svelte';
  import DocumentReviewersPanel from '$lib/components/admin/access/DocumentReviewersPanel.svelte';
  import { m } from '$lib/paraglide/messages';

  const TABS = ['readers', 'reviewers'] as const;
  type Tab = (typeof TABS)[number];

  let ready = $state(false);
  /** Whether this viewer may see the named readers (global admin). */
  let canGrant = $state(false);
  // `?tab=` keeps the tab across a reload; written as a shallow `goto`, see `tabQuery`.
  let tab = $state<Tab>(parseTab(page.url.searchParams.get('tab'), TABS, 'readers'));

  function switchTab(next: Tab) {
    Log.d('admin.read-access.switchTab', { next });
    tab = next;
    void goto(resolve(internalPath(tabUrl(page.url, next, 'readers'))), {
      shallow: true,
      replace: true,
      state: page.state,
    });
  }

  onMount(async () => {
    await ensureAssociationSuperAdmin();
    if (!isGlobalAdmin() && !isAssociationSuperAdmin()) {
      void goto(resolve('/admin'), { replace: true });
      return;
    }
    // Cross-space rights stay with global admins (D24): the readers and their journal are theirs alone.
    canGrant = isGlobalAdmin();
    ready = true;
  });
</script>

<PageHeader title={m.readaccess_nav_label()} />

{#if ready}
  {#if canGrant}
    <SegmentedControl
      class="mb-6"
      items={[
        { key: 'readers', label: m.readaccess_title(), icon: Eye },
        { key: 'reviewers', label: m.docreview_title(), icon: FileCheckCorner },
      ]}
      value={tab}
      onSelect={switchTab}
      label={m.readaccess_tabs_label()}
      tone="yellow"
      idPrefix="read-access-"
    />
    <div role="tabpanel" id="read-access-tabpanel-{tab}" aria-labelledby="read-access-tab-{tab}">
      {#if tab === 'readers'}
        <ReadAccessPanel titleHidden />
      {:else}
        <DocumentReviewersPanel titleHidden />
      {/if}
    </div>
  {:else}
    <DocumentReviewersPanel />
  {/if}
{/if}
