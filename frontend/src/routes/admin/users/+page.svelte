<script lang="ts">
  import { onMount } from 'svelte';
  import { Shield, RefreshCw, Users } from 'lucide-svelte';
  import { apiFetch } from '$lib/utils/apiFetch';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { goto } from '$app/navigation';

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

  let filtered = $derived(
    searchQuery.trim()
      ? users.filter(
          (u) =>
            u.displayName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
            u.id.toLowerCase().includes(searchQuery.toLowerCase())
        )
      : users
  );

  async function load() {
    loading = true;
    error = '';
    try {
      const res = await apiFetch('/api/users/admin/list');
      if (!res.ok) throw new Error(`Erreur ${res.status}`);
      users = await res.json();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Erreur chargement';
    } finally {
      loading = false;
    }
  }

  async function toggleAdmin(user: AdminUser) {
    const newVal = !user.admin;
    saving = { ...saving, [user.id]: true };
    feedback = { ...feedback, [user.id]: '' };
    try {
      const res = await apiFetch(`/api/users/${encodeURIComponent(user.id)}/admin`, {
        method: 'PATCH',
        body: JSON.stringify({ admin: newVal }),
      });
      if (!res.ok) throw new Error(`Erreur ${res.status}`);
      users = users.map((u) => (u.id === user.id ? { ...u, admin: newVal } : u));
      feedback = { ...feedback, [user.id]: newVal ? 'Admin accordé' : 'Admin retiré' };
      setTimeout(() => {
        feedback = { ...feedback, [user.id]: '' };
      }, 2000);
    } catch (e) {
      feedback = { ...feedback, [user.id]: e instanceof Error ? e.message : 'Erreur' };
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

<div class="max-w-3xl mx-auto px-4 py-8 space-y-6">
  <div class="flex items-center justify-between gap-4">
    <div class="flex items-center gap-3">
      <div class="p-2.5 rounded-xl bg-amber-500/10 text-amber-600">
        <Users size={22} strokeWidth={2.5} />
      </div>
      <div>
        <h1 class="text-2xl font-extrabold text-text-main">Gestion des admins</h1>
        <p class="text-sm text-text-muted">Accordez ou retirez les droits d'administration globaux.</p>
      </div>
    </div>
    <button
      type="button"
      onclick={load}
      disabled={loading}
      class="p-2 rounded-xl text-text-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
      title="Rafraîchir"
    >
      <RefreshCw size={18} class={loading ? 'animate-spin' : ''} />
    </button>
  </div>

  {#if error}
    <div class="p-4 rounded-xl bg-red-50 dark:bg-red-900/20 text-red-600 text-sm border border-red-200 dark:border-red-800">
      {error}
    </div>
  {/if}

  <input
    type="search"
    bind:value={searchQuery}
    placeholder="Rechercher un utilisateur…"
    class="w-full bg-white/80 dark:bg-black/40 border border-black/10 dark:border-white/10 rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-amber-500/50"
  />

  {#if loading}
    <div class="text-sm text-text-muted">Chargement…</div>
  {:else if filtered.length === 0}
    <div class="text-sm text-text-muted">Aucun utilisateur trouvé.</div>
  {:else}
    <ul class="space-y-2">
      {#each filtered as user (user.id)}
        <li class="flex items-center justify-between gap-3 bg-white/60 dark:bg-black/20 border border-black/5 dark:border-white/10 rounded-2xl px-4 py-3 shadow-sm">
          <div class="flex items-center gap-3 min-w-0">
            {#if user.admin}
              <Shield size={16} class="text-amber-500 flex-shrink-0" strokeWidth={2.5} />
            {:else}
              <Shield size={16} class="text-text-muted opacity-30 flex-shrink-0" strokeWidth={2} />
            {/if}
            <div class="min-w-0">
              <p class="font-semibold text-sm text-text-main truncate">
                {user.displayName ?? user.id}
              </p>
              <p class="text-xs text-text-muted font-mono truncate">{user.id}</p>
            </div>
          </div>

          <div class="flex items-center gap-3 flex-shrink-0">
            {#if feedback[user.id]}
              <span class="text-xs text-emerald-600 font-medium">{feedback[user.id]}</span>
            {/if}
            <button
              type="button"
              onclick={() => toggleAdmin(user)}
              disabled={saving[user.id]}
              class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 {user.admin ? 'bg-amber-500' : 'bg-black/10 dark:bg-white/20'}"
              role="switch"
              aria-checked={user.admin ?? false}
              title={user.admin ? 'Retirer admin' : 'Accorder admin'}
            >
              <span class="sr-only">{user.admin ? 'Retirer admin' : 'Accorder admin'}</span>
              <span
                class="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform {user.admin ? 'translate-x-6' : 'translate-x-1'}"
              ></span>
            </button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>
