<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { apiFetch } from '$lib/utils/apiFetch';
  import { coreUrl } from '$lib/utils/apiUrl';
  import { refreshAppVersionCheck } from '$lib/stores/appVersionCheck.svelte';
  import { Wrench, Save, RefreshCw } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  type PlatformConfig = {
    maintenanceEnabled: boolean;
    maintenanceMessage: string | null;
    minClientVersion: string;
  };

  let loading = $state(true);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let savedMessage = $state('');

  let maintenanceEnabled = $state(false);
  let maintenanceMessage = $state('');
  let minClientVersion = $state('0.0.0');

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
  });
</script>

<div class="space-y-6">
  <header class="flex items-start gap-3">
    <span class="flex h-10 w-10 items-center justify-center rounded-xl bg-cn-yellow/15 text-cn-dark">
      <Wrench size={20} />
    </span>
    <div>
      <h2 class="text-lg font-extrabold text-text-main">{m.admin_platform_label()}</h2>
      <p class="text-sm text-text-muted mt-0.5">
        {m.admin_platform_subtitle()}
      </p>
    </div>
  </header>

  {#if loading}
    <div class="flex justify-center py-16">
      <div
        class="h-8 w-8 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
      ></div>
    </div>
  {:else}
    <form
      class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-5 space-y-5"
      onsubmit={(e) => {
        e.preventDefault();
        void saveConfig();
      }}
    >
      <label class="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          bind:checked={maintenanceEnabled}
          class="mt-1 h-4 w-4 rounded border-cn-border text-cn-yellow focus:ring-cn-yellow"
        />
        <span>
          <span class="block text-sm font-bold text-text-main">{m.admin_platform_maintenance_toggle_label()}</span>
          <span class="block text-xs text-text-muted mt-0.5">
            {m.admin_platform_maintenance_toggle_desc()}
          </span>
        </span>
      </label>

      <div class="space-y-1.5">
        <label for="maintenance-message" class="text-sm font-bold text-text-main">
          {m.admin_platform_message_label()}
        </label>
        <textarea
          id="maintenance-message"
          bind:value={maintenanceMessage}
          rows="3"
          maxlength="2000"
          placeholder={m.admin_platform_message_placeholder()}
          class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm text-text-main placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-cn-yellow/40"
        ></textarea>
      </div>

      <div class="space-y-1.5">
        <label for="min-client-version" class="text-sm font-bold text-text-main">
          {m.admin_platform_min_version_label()}
        </label>
        <input
          id="min-client-version"
          type="text"
          bind:value={minClientVersion}
          pattern="^\d+\.\d+\.\d+$"
          required
          class="w-full max-w-xs rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm font-mono text-text-main focus:outline-none focus:ring-2 focus:ring-cn-yellow/40"
        />
        <p class="text-xs text-text-muted">{m.admin_platform_min_version_hint_prefix()} <code>major.minor.patch</code> {m.admin_platform_min_version_hint_suffix()}</p>
      </div>

      {#if error}
        <p class="text-sm text-red-500" role="alert">{error}</p>
      {/if}
      {#if savedMessage}
        <p class="text-sm text-emerald-600" role="status">{savedMessage}</p>
      {/if}

      <div class="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={saving}
          class="inline-flex items-center gap-2 rounded-xl bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50"
        >
          <Save size={16} />
          {saving ? 'Enregistrement…' : 'Enregistrer'}
        </button>
        <button
          type="button"
          disabled={loading || saving}
          onclick={() => void loadConfig()}
          class="inline-flex items-center gap-2 rounded-xl border border-cn-border px-4 py-2 text-sm font-bold text-text-muted hover:text-text-main disabled:opacity-50"
        >
          <RefreshCw size={16} />
          Recharger
        </button>
      </div>
    </form>
  {/if}
</div>
