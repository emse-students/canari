<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { apiFetch } from '$lib/utils/apiFetch';
  import { coreUrl } from '$lib/utils/apiUrl';
  import { refreshAppVersionCheck } from '$lib/stores/appVersionCheck.svelte';
  import { Wrench, Save, RefreshCw, Megaphone, Trash2 } from '@lucide/svelte';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { m } from '$lib/paraglide/messages';

  type PlatformConfig = {
    maintenanceEnabled: boolean;
    maintenanceMessage: string | null;
    minClientVersion: string;
    paymentProvider: 'stripe' | 'lydia';
  };

  let loading = $state(true);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let savedMessage = $state('');

  let maintenanceEnabled = $state(false);
  let maintenanceMessage = $state('');
  let minClientVersion = $state('0.0.0');
  let paymentProvider = $state<'stripe' | 'lydia'>('stripe');

  /** The live announcement as the server holds it, or null when none is published. */
  type ActiveAnnouncement = {
    id: string;
    titleFr: string;
    titleEn: string;
    bodyFr: string;
    bodyEn: string;
    minClientVersion: string | null;
    maxClientVersion: string | null;
    seenCount: number;
  };

  let announcement = $state<ActiveAnnouncement | null>(null);
  let announcementSaving = $state(false);
  let announcementError = $state<string | null>(null);
  let announcementSaved = $state('');

  let titleFr = $state('');
  let titleEn = $state('');
  let bodyFr = $state('');
  let bodyEn = $state('');
  let annMinVersion = $state('');
  let annMaxVersion = $state('');

  const announcementComplete = $derived(
    titleFr.trim() !== '' && titleEn.trim() !== '' && bodyFr.trim() !== '' && bodyEn.trim() !== ''
  );

  /** Loads the live announcement into the form, so publishing an edit starts from what is out. */
  async function loadAnnouncement() {
    announcementError = null;
    try {
      const res = await apiFetch(`${coreUrl()}/api/users/admin/platform/announcement`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Wrapped server-side so that "nothing published" is a body rather than no body at all.
      const data = ((await res.json()) as { announcement: ActiveAnnouncement | null }).announcement;
      announcement = data;
      titleFr = data?.titleFr ?? '';
      titleEn = data?.titleEn ?? '';
      bodyFr = data?.bodyFr ?? '';
      bodyEn = data?.bodyEn ?? '';
      annMinVersion = data?.minClientVersion ?? '';
      annMaxVersion = data?.maxClientVersion ?? '';
    } catch (e) {
      announcementError = e instanceof Error ? e.message : m.admin_announcement_load_error();
    }
  }

  async function publishAnnouncement() {
    // Replacing is not an edit: the "seen" rows are keyed by announcement, so everyone sees the new
    // one, including the accounts that had already read the old. Said out loud before it happens.
    if (
      announcement &&
      !(await showConfirm(m.admin_announcement_replace_confirm(), {
        confirmLabel: m.admin_announcement_publish_button(),
      }))
    ) {
      return;
    }
    announcementSaving = true;
    announcementError = null;
    announcementSaved = '';
    try {
      const res = await apiFetch(`${coreUrl()}/api/users/admin/platform/announcement`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          titleFr: titleFr.trim(),
          titleEn: titleEn.trim(),
          bodyFr: bodyFr.trim(),
          bodyEn: bodyEn.trim(),
          minClientVersion: annMinVersion.trim(),
          maxClientVersion: annMaxVersion.trim(),
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `HTTP ${res.status}`);
      }
      announcement = (await res.json()) as ActiveAnnouncement;
      announcementSaved = m.admin_announcement_published_label();
    } catch (e) {
      announcementError = e instanceof Error ? e.message : m.admin_announcement_save_error();
    } finally {
      announcementSaving = false;
    }
  }

  async function retireAnnouncement() {
    if (
      !(await showConfirm(m.admin_announcement_retire_confirm(), {
        danger: true,
        confirmLabel: m.admin_announcement_retire_button(),
      }))
    ) {
      return;
    }
    announcementSaving = true;
    announcementError = null;
    announcementSaved = '';
    try {
      const res = await apiFetch(`${coreUrl()}/api/users/admin/platform/announcement`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      announcement = null;
      announcementSaved = m.admin_announcement_retired_label();
    } catch (e) {
      announcementError = e instanceof Error ? e.message : m.admin_announcement_save_error();
    } finally {
      announcementSaving = false;
    }
  }

  async function loadConfig() {
    loading = true;
    error = null;
    savedMessage = '';
    try {
      const res = await apiFetch(`${coreUrl()}/api/users/admin/platform`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as PlatformConfig;
      maintenanceEnabled = data.maintenanceEnabled;
      maintenanceMessage = data.maintenanceMessage ?? '';
      minClientVersion = data.minClientVersion;
      paymentProvider = data.paymentProvider;
    } catch (e) {
      error = e instanceof Error ? e.message : m.admin_platform_load_error();
    } finally {
      loading = false;
    }
  }

  async function saveConfig() {
    saving = true;
    error = null;
    savedMessage = '';
    try {
      const res = await apiFetch(`${coreUrl()}/api/users/admin/platform`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          maintenanceEnabled,
          maintenanceMessage: maintenanceMessage.trim() || null,
          minClientVersion: minClientVersion.trim(),
          paymentProvider,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as PlatformConfig;
      maintenanceEnabled = data.maintenanceEnabled;
      maintenanceMessage = data.maintenanceMessage ?? '';
      minClientVersion = data.minClientVersion;
      paymentProvider = data.paymentProvider;
      savedMessage = m.admin_platform_saved_label();
      void refreshAppVersionCheck();
    } catch (e) {
      error = e instanceof Error ? e.message : m.admin_platform_save_error();
    } finally {
      saving = false;
    }
  }

  onMount(() => {
    if (!isGlobalAdmin()) {
      void goto('/admin', { replaceState: true });
      return;
    }
    void loadConfig();
    void loadAnnouncement();
  });
</script>

<div class="space-y-6">
  <header class="flex items-start gap-3">
    <span
      class="bg-cn-yellow/15 text-cn-dark flex h-10 w-10 items-center justify-center rounded-xl"
    >
      <Wrench size={20} />
    </span>
    <div>
      <h2 class="text-text-main text-lg font-extrabold">{m.admin_platform_label()}</h2>
      <p class="text-text-muted mt-0.5 text-sm">
        {m.admin_platform_subtitle()}
      </p>
    </div>
  </header>

  {#if loading}
    <div class="flex justify-center py-16">
      <div
        class="border-cn-yellow h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
      ></div>
    </div>
  {:else}
    <form
      class="border-cn-border space-y-5 rounded-2xl border bg-(--cn-surface) p-5"
      onsubmit={(e) => {
        e.preventDefault();
        void saveConfig();
      }}
    >
      <label class="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          bind:checked={maintenanceEnabled}
          class="border-cn-border text-cn-yellow focus:ring-cn-yellow mt-1 h-4 w-4 rounded"
        />
        <span>
          <span class="text-text-main block text-sm font-bold"
            >{m.admin_platform_maintenance_toggle_label()}</span
          >
          <span class="text-text-muted mt-0.5 block text-xs">
            {m.admin_platform_maintenance_toggle_desc()}
          </span>
        </span>
      </label>

      <div class="space-y-1.5">
        <label for="maintenance-message" class="text-text-main text-sm font-bold">
          {m.admin_platform_message_label()}
        </label>
        <textarea
          id="maintenance-message"
          bind:value={maintenanceMessage}
          rows="3"
          maxlength="2000"
          placeholder={m.admin_platform_message_placeholder()}
          class="border-cn-border text-text-main placeholder:text-text-muted focus:ring-cn-yellow/40 w-full rounded-xl border bg-transparent px-3 py-2 text-sm focus:ring-2 focus:outline-none"
        ></textarea>
      </div>

      <div class="space-y-1.5">
        <label for="min-client-version" class="text-text-main text-sm font-bold">
          {m.admin_platform_min_version_label()}
        </label>
        <input
          id="min-client-version"
          type="text"
          bind:value={minClientVersion}
          pattern="^\d+\.\d+\.\d+$"
          required
          class="border-cn-border text-text-main focus:ring-cn-yellow/40 w-full max-w-xs rounded-xl border bg-transparent px-3 py-2 font-mono text-sm focus:ring-2 focus:outline-none"
        />
        <p class="text-text-muted text-xs">
          {m.admin_platform_min_version_hint_prefix()} <code>major.minor.patch</code>
          {m.admin_platform_min_version_hint_suffix()}
        </p>
      </div>

      <div class="space-y-1.5">
        <label for="payment-provider" class="text-text-main text-sm font-bold">
          {m.admin_platform_payment_provider_label()}
        </label>
        <select
          id="payment-provider"
          bind:value={paymentProvider}
          class="border-cn-border text-text-main focus:ring-cn-yellow/40 w-full max-w-xs rounded-xl border bg-transparent px-3 py-2 text-sm focus:ring-2 focus:outline-none"
        >
          <option value="stripe">Stripe</option>
          <option value="lydia">Lydia</option>
        </select>
        <p class="text-text-muted text-xs">
          {m.admin_platform_payment_provider_hint()}
        </p>
      </div>

      {#if error}
        <p class="text-sm text-red-500" role="alert">{error}</p>
      {/if}
      {#if savedMessage}
        <p class="text-green-ok text-sm" role="status">{savedMessage}</p>
      {/if}

      <div class="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={saving}
          class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-50"
        >
          <Save size={16} />
          {saving ? m.common_saving_label() : m.common_save_button()}
        </button>
        <button
          type="button"
          disabled={loading || saving}
          onclick={() => void loadConfig()}
          class="border-cn-border text-text-muted hover:text-text-main inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-bold disabled:opacity-50"
        >
          <RefreshCw size={16} />
          {m.common_reload_button()}
        </button>
      </div>
    </form>

    <form
      class="border-cn-border space-y-5 rounded-2xl border bg-(--cn-surface) p-5"
      onsubmit={(e) => {
        e.preventDefault();
        void publishAnnouncement();
      }}
    >
      <header class="flex items-start gap-3">
        <span
          class="bg-cn-yellow/15 text-cn-dark flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
        >
          <Megaphone size={18} />
        </span>
        <div>
          <h3 class="text-text-main text-sm font-bold">{m.admin_announcement_section_title()}</h3>
          <p class="text-text-muted mt-0.5 text-xs">{m.admin_announcement_section_desc()}</p>
        </div>
      </header>

      <p class="text-text-muted text-xs">
        {#if announcement}
          <span class="text-text-main font-bold">{m.admin_announcement_active_label()}</span>
          - {m.admin_announcement_seen_count({ count: announcement.seenCount })}
        {:else}
          {m.admin_announcement_none_label()}
        {/if}
      </p>

      <div class="grid gap-4 sm:grid-cols-2">
        <div class="space-y-1.5">
          <label for="ann-title-fr" class="text-text-main text-sm font-bold">
            {m.admin_announcement_title_fr_label()}
          </label>
          <input
            id="ann-title-fr"
            type="text"
            bind:value={titleFr}
            maxlength="200"
            class="border-cn-border text-text-main focus:ring-cn-yellow/40 w-full rounded-xl border bg-transparent px-3 py-2 text-sm focus:ring-2 focus:outline-none"
          />
        </div>
        <div class="space-y-1.5">
          <label for="ann-title-en" class="text-text-main text-sm font-bold">
            {m.admin_announcement_title_en_label()}
          </label>
          <input
            id="ann-title-en"
            type="text"
            bind:value={titleEn}
            maxlength="200"
            class="border-cn-border text-text-main focus:ring-cn-yellow/40 w-full rounded-xl border bg-transparent px-3 py-2 text-sm focus:ring-2 focus:outline-none"
          />
        </div>
        <div class="space-y-1.5">
          <label for="ann-body-fr" class="text-text-main text-sm font-bold">
            {m.admin_announcement_body_fr_label()}
          </label>
          <textarea
            id="ann-body-fr"
            bind:value={bodyFr}
            rows="5"
            maxlength="4000"
            class="border-cn-border text-text-main focus:ring-cn-yellow/40 w-full rounded-xl border bg-transparent px-3 py-2 text-sm focus:ring-2 focus:outline-none"
          ></textarea>
        </div>
        <div class="space-y-1.5">
          <label for="ann-body-en" class="text-text-main text-sm font-bold">
            {m.admin_announcement_body_en_label()}
          </label>
          <textarea
            id="ann-body-en"
            bind:value={bodyEn}
            rows="5"
            maxlength="4000"
            class="border-cn-border text-text-main focus:ring-cn-yellow/40 w-full rounded-xl border bg-transparent px-3 py-2 text-sm focus:ring-2 focus:outline-none"
          ></textarea>
        </div>
      </div>
      <p class="text-text-muted text-xs">{m.admin_announcement_both_languages_hint()}</p>

      <div class="grid gap-4 sm:grid-cols-2">
        <div class="space-y-1.5">
          <label for="ann-min-version" class="text-text-main text-sm font-bold">
            {m.admin_announcement_min_version_label()}
          </label>
          <input
            id="ann-min-version"
            type="text"
            bind:value={annMinVersion}
            pattern="^(\d+\.\d+\.\d+)?$"
            placeholder="0.15.0"
            class="border-cn-border text-text-main focus:ring-cn-yellow/40 w-full rounded-xl border bg-transparent px-3 py-2 font-mono text-sm focus:ring-2 focus:outline-none"
          />
        </div>
        <div class="space-y-1.5">
          <label for="ann-max-version" class="text-text-main text-sm font-bold">
            {m.admin_announcement_max_version_label()}
          </label>
          <input
            id="ann-max-version"
            type="text"
            bind:value={annMaxVersion}
            pattern="^(\d+\.\d+\.\d+)?$"
            placeholder="0.15.9"
            class="border-cn-border text-text-main focus:ring-cn-yellow/40 w-full rounded-xl border bg-transparent px-3 py-2 font-mono text-sm focus:ring-2 focus:outline-none"
          />
        </div>
      </div>
      <p class="text-text-muted text-xs">{m.admin_announcement_version_hint()}</p>

      {#if announcementError}
        <p class="text-sm text-red-500" role="alert">{announcementError}</p>
      {/if}
      {#if announcementSaved}
        <p class="text-green-ok text-sm" role="status">{announcementSaved}</p>
      {/if}

      <div class="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={announcementSaving || !announcementComplete}
          class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-50"
        >
          <Save size={16} />
          {announcementSaving ? m.common_saving_label() : m.admin_announcement_publish_button()}
        </button>
        {#if announcement}
          <button
            type="button"
            disabled={announcementSaving}
            onclick={() => void retireAnnouncement()}
            class="border-cn-border inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-bold text-red-500 hover:bg-red-500/10 disabled:opacity-50"
          >
            <Trash2 size={16} />
            {m.admin_announcement_retire_button()}
          </button>
        {/if}
      </div>
    </form>
  {/if}
</div>
