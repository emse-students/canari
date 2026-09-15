<script lang="ts">
  import { onMount } from 'svelte';
  import { Log } from '$lib/utils/Log';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { getGroupInvitePreview, acceptGroupInvite } from '$lib/mls/groupInvites';
  import { currentUserId } from '$lib/stores/user';
  import { Users, LoaderCircle, CircleAlert, Check } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';

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
      Log.d('group invite preview failed', e);
      error = m.invite_not_found();
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
      Log.d('group invite accept failed', e);
      error = m.group_join_error_fallback();
      joining = false;
    }
  }
</script>

<!--
  THE PAGE IS A DECLARED SHAPE AND THE CARD OWNS ITS OWN WIDTH. This was `mx-auto max-w-md` on the
  page itself - 448px, a width no scale declares - which is the page column being written by hand.
  The 448 was never wrong FOR THE CARD: a one-decision interstitial should not run the width of a
  catalogue. So the number moved onto the card, where it is a card measurement, and the page takes
  the same column and the same vertical rhythm as every other route.
-->
<PageContainer>
  <div
    class="border-cn-border mx-auto max-w-md space-y-5 rounded-2xl border bg-(--cn-surface) p-8 text-center shadow-sm"
  >
    {#if loading}
      <div class="flex justify-center py-6">
        <LoaderCircle size={28} class="text-cn-yellow animate-spin" />
      </div>
    {:else if joined}
      <div class="flex flex-col items-center gap-3 py-2">
        <div
          class="text-green-ok flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10"
        >
          <Check size={30} />
        </div>
        <p class="text-text-main text-sm font-semibold">{m.group_join_sent_title()}</p>
        <p class="text-text-muted text-xs leading-relaxed">
          {m.group_join_sent_desc({ name: preview?.groupName ?? m.group_join_group_fallback() })}
        </p>
        <a
          href="/chat"
          class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover mt-1 rounded-xl px-5 py-2.5 text-sm font-bold transition-colors"
        >
          {m.group_join_go_to_chat()}
        </a>
      </div>
    {:else if error || !preview?.valid}
      <div class="flex flex-col items-center gap-3 py-4">
        <CircleAlert size={36} class="text-red-500" />
        <p class="text-text-main text-sm font-semibold">{m.invite_invalid_or_expired()}</p>
        {#if error}<p class="text-text-muted text-xs">{error}</p>{/if}
        <a href="/chat" class="text-cn-dark text-sm font-semibold hover:underline">
          {m.group_join_back_chat()}
        </a>
      </div>
    {:else}
      <div
        class="bg-cn-yellow/10 text-cn-dark mx-auto flex h-16 w-16 items-center justify-center rounded-2xl"
      >
        <Users size={30} />
      </div>
      <div>
        <p class="text-text-muted text-sm">{m.group_join_invited_text()}</p>
        <h1 class="text-text-main mt-1 text-xl font-bold">
          {preview.groupName ?? m.group_join_group_fallback()}
        </h1>
      </div>
      <button
        type="button"
        onclick={join}
        disabled={joining}
        class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover w-full rounded-xl px-5 py-2.5 text-sm font-bold transition-colors disabled:opacity-50"
      >
        {joining ? m.common_sending_label() : m.group_join_btn()}
      </button>
      <a href="/chat" class="text-text-muted hover:text-text-main block text-xs"
        >{m.common_cancel_button()}</a
      >
    {/if}
  </div>
</PageContainer>
