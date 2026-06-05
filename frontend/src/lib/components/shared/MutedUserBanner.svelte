<script lang="ts">
  import { ShieldAlert } from '@lucide/svelte';
  import { getMyMuteStatus } from '$lib/moderation/api';
  import { currentUserId } from '$lib/stores/user';

  let isMuted = $state(false);
  let mutedReason = $state<string | null>(null);

  async function refresh() {
    const uid = currentUserId();
    if (!uid) {
      isMuted = false;
      mutedReason = null;
      return;
    }
    try {
      const status = await getMyMuteStatus();
      isMuted = status.isMuted;
      mutedReason = status.mutedReason;
    } catch {
      isMuted = false;
      mutedReason = null;
    }
  }

  $effect(() => {
    const uid = currentUserId();
    if (!uid) {
      isMuted = false;
      mutedReason = null;
      return;
    }
    void refresh();
    const interval = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(interval);
  });
</script>

{#if isMuted}
  <div
    class="fixed top-[env(safe-area-inset-top)] left-0 right-0 z-[49] flex items-start gap-3 px-4 py-2.5 text-sm text-white bg-red-700 shadow-md"
    role="alert"
  >
    <ShieldAlert size={18} class="shrink-0 mt-0.5" />
    <div class="flex-1 min-w-0">
      <p class="font-semibold">Compte restreint par la modération</p>
      {#if mutedReason}
        <p class="text-white/90 text-xs mt-0.5 leading-relaxed">{mutedReason}</p>
      {:else}
        <p class="text-white/90 text-xs mt-0.5">
          Vous ne pouvez pas publier, commenter ni réagir pour le moment.
        </p>
      {/if}
    </div>
  </div>
{/if}
