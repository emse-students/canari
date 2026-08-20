<script lang="ts">
  import { onMount } from 'svelte';
  import { Shield, RefreshCw, Users } from '@lucide/svelte';
  import { apiFetch } from '$lib/utils/apiFetch';
  import { coreUrl } from '$lib/utils/apiUrl';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { goto } from '$app/navigation';
  import { m } from '$lib/paraglide/messages';

  interface AdminUser {
    id: string;
    displayName?: string | null;
    admin?: boolean;
  }

  let users = $state<AdminUser[]>([]);
  let loading = $state(true);
  let error = $state('');
  let saving = $state<Record<string, boolean>>({});
  let feedback = $state<Record<string, string>>({});
  let searchQuery = $state('');

  /** Strips accents and lowercases for locale-insensitive comparison. */
  function normalize(s: string): string {
    return s
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase();
  }

  let filtered = $derived(
    searchQuery.trim()
      ? (() => {
          const terms = normalize(searchQuery).split(/\s+/).filter(Boolean);
          return users.filter((u) => {
            const name = normalize(u.displayName ?? '');
            const id = normalize(u.id);
            return terms.every((t) => name.includes(t) || id.includes(t));
          });
        })()
      : users
  );

  async function load() {
    loading = true;
    error = '';
    try {
      const res = await apiFetch(`${coreUrl()}/api/users/admin/list`);
      if (!res.ok) throw new Error(m.admin_users_http_error_label({ status: res.status }));
      users = await res.json();
    } catch (e) {
      error = e instanceof Error ? e.message : m.admin_users_load_error();
    } finally {
      loading = false;
    }
  }

  async function toggleAdmin(user: AdminUser) {
    const newVal = !user.admin;
    saving = { ...saving, [user.id]: true };
    feedback = { ...feedback, [user.id]: '' };
    try {
      const res = await apiFetch(`${coreUrl()}/api/users/${encodeURIComponent(user.id)}/admin`, {
        method: 'PATCH',
        body: JSON.stringify({ admin: newVal }),
      });
      if (!res.ok) throw new Error(m.admin_users_http_error_label({ status: res.status }));
      users = users.map((u) => (u.id === user.id ? { ...u, admin: newVal } : u));
      feedback = {
        ...feedback,
        [user.id]: newVal ? m.admin_users_granted_label() : m.admin_users_revoked_label(),
      };
      setTimeout(() => {
        feedback = { ...feedback, [user.id]: '' };
      }, 2000);
    } catch (e) {
      feedback = {
        ...feedback,
        [user.id]: e instanceof Error ? e.message : m.common_generic_error_label(),
      };
    } finally {
      saving = { ...saving, [user.id]: false };
    }
  }

  onMount(async () => {
    if (!isGlobalAdmin()) {
      goto('/');
      return;
    }
    await load();
  });
</script>

<div class="mx-auto max-w-3xl space-y-6 px-4 py-8">
  <div class="flex items-center justify-between gap-4">
    <div class="flex items-center gap-3">
      <div class="text-amber-warn rounded-xl bg-amber-500/10 p-2.5">
        <Users size={22} strokeWidth={2.5} />
      </div>
      <div>
        <h1 class="text-text-main text-2xl font-extrabold">{m.admin_card_manage_admins_label()}</h1>
        <p class="text-text-muted text-sm">
          {m.admin_users_subtitle()}
        </p>
      </div>
    </div>
    <button
      type="button"
      onclick={load}
      disabled={loading}
      class="text-text-muted rounded-xl p-2 transition-colors hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
      title={m.moderation_refresh()}
    >
      <RefreshCw size={18} class={loading ? 'animate-spin' : ''} />
    </button>
  </div>

  {#if error}
    <div class="bg-red-err/10 text-red-err border-red-err/30 rounded-xl border p-4 text-sm">
      {error}
    </div>
  {/if}

  <input
    type="search"
    bind:value={searchQuery}
    placeholder={m.admin_users_search_placeholder()}
    class="w-full rounded-xl border border-black/10 bg-white/80 px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-amber-500/50 dark:border-white/10 dark:bg-black/40"
  />

  {#if loading}
    <div class="text-text-muted text-sm">{m.common_loading_label()}</div>
  {:else if filtered.length === 0}
    <div class="text-text-muted text-sm">{m.admin_users_empty()}</div>
  {:else}
    <ul class="space-y-2">
      {#each filtered as user (user.id)}
        <li
          class="flex items-center justify-between gap-3 rounded-2xl border border-black/5 bg-white/60 px-4 py-3 shadow-sm dark:border-white/10 dark:bg-black/20"
        >
          <div class="flex min-w-0 items-center gap-3">
            {#if user.admin}
              <Shield size={16} class="flex-shrink-0 text-amber-500" strokeWidth={2.5} />
            {:else}
              <Shield size={16} class="text-text-muted flex-shrink-0 opacity-30" strokeWidth={2} />
            {/if}
            <div class="min-w-0">
              <p class="text-text-main truncate text-sm font-semibold">
                {user.displayName ?? user.id}
              </p>
              <p class="text-text-muted truncate font-mono text-xs">{user.id}</p>
            </div>
          </div>

          <div class="flex flex-shrink-0 items-center gap-3">
            {#if feedback[user.id]}
              <span class="text-green-ok text-xs font-medium">{feedback[user.id]}</span>
            {/if}
            <button
              type="button"
              onclick={() => toggleAdmin(user)}
              disabled={saving[user.id]}
              class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 {user.admin
                ? 'bg-amber-500'
                : 'bg-black/10 dark:bg-white/20'}"
              role="switch"
              aria-checked={user.admin ?? false}
              title={user.admin
                ? m.admin_users_revoke_action_label()
                : m.admin_users_grant_action_label()}
            >
              <span class="sr-only"
                >{user.admin
                  ? m.admin_users_revoke_action_label()
                  : m.admin_users_grant_action_label()}</span
              >
              <span
                class="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform {user.admin
                  ? 'translate-x-6'
                  : 'translate-x-1'}"
              ></span>
            </button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>
