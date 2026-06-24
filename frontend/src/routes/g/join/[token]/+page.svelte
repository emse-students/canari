<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { getGroupInvitePreview, acceptGroupInvite } from '$lib/mls/groupInvites';
  import { currentUserId } from '$lib/stores/user';
  import { Users, Loader2, AlertCircle, Check } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  const token = $derived((page.params as Record<string, string>).token);

  let loading = $state(true);
  let joining = $state(false);
  let joined = $state(false);
  let error = $state('');
  let preview = $state<{ valid: boolean; groupId: string | null; groupName: string | null } | null>(
    null
  );

  onMount(async () => {
    if (!currentUserId()) {
      await goto(`/login?returnTo=${encodeURIComponent(`/g/join/${token}`)}`, {
        replaceState: true,
      });
      return;
    }
    try {
      preview = await getGroupInvitePreview(token);
    } catch (e) {
      error = e instanceof Error ? e.message : m.invite_not_found();
    } finally {
      loading = false;
    }
  });

  async function join() {
    joining = true;
    error = '';
    try {
      await acceptGroupInvite(token);
      joined = true;
    } catch (e) {
      error = e instanceof Error ? e.message : m.group_join_error_fallback();
      joining = false;
    }
  }
</script>

<svelte:head><title>{m.group_join_page_title()}</title></svelte:head>

<div class="px-4 py-10 max-w-md mx-auto">
  <div
    class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-8 shadow-sm text-center space-y-5"
  >
    {#if loading}
      <div class="flex justify-center py-6">
        <Loader2 size={28} class="animate-spin text-cn-yellow" />
      </div>
    {:else if joined}
      <div class="flex flex-col items-center gap-3 py-2">
        <div class="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
          <Check size={30} />
        </div>
        <p class="text-sm font-semibold text-text-main">{m.group_join_sent_title()}</p>
        <p class="text-xs text-text-muted leading-relaxed">
          {m.group_join_sent_desc({ name: preview?.groupName ?? m.group_join_group_fallback() })}
        </p>
        <a
          href="/chat"
          class="mt-1 rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover transition-colors"
        >
          {m.group_join_go_to_chat()}
        </a>
      </div>
    {:else if error || !preview?.valid}
      <div class="flex flex-col items-center gap-3 py-4">
        <AlertCircle size={36} class="text-red-500" />
        <p class="text-sm font-semibold text-text-main">{m.invite_invalid_or_expired()}</p>
        {#if error}<p class="text-xs text-text-muted">{error}</p>{/if}
        <a href="/chat" class="text-sm font-semibold text-cn-dark hover:underline">
          {m.group_join_back_chat()}
        </a>
      </div>
    {:else}
      <div class="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-cn-yellow/10 text-cn-dark">
        <Users size={30} />
      </div>
      <div>
        <p class="text-sm text-text-muted">{m.group_join_invited_text()}</p>
        <h1 class="text-xl font-extrabold text-text-main mt-1">
          {preview.groupName ?? m.group_join_group_fallback()}
        </h1>
      </div>
      <button
        type="button"
        onclick={join}
        disabled={joining}
        class="w-full rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50 transition-colors"
      >
        {joining ? m.common_sending_label() : m.group_join_btn()}
      </button>
      <a href="/chat" class="block text-xs text-text-muted hover:text-text-main">{m.common_cancel_button()}</a>
    {/if}
  </div>
</div>
