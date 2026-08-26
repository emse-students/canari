<script lang="ts">
  import { onMount } from 'svelte';
  import { Tag, ShoppingBag, ChevronRight, LoaderCircle } from '@lucide/svelte';
  import { apiFetch } from '$lib/utils/apiFetch';
  import { socialUrl } from '$lib/utils/apiUrl';
  import type { UserTag } from '$lib/associations/api';
  import CotisationTagRow from '$lib/components/shared/CotisationTagRow.svelte';
  import { m } from '$lib/paraglide/messages';

  // Active membership tags (cotisations) bought through forms. Loaded here so the section is
  // self-contained; the full purchase history lives at /account/purchases.
  let activeTags = $state<UserTag[]>([]);
  let purchasesLoading = $state(false);

  onMount(loadPurchasesSummary);

  async function loadPurchasesSummary() {
    purchasesLoading = true;
    try {
      const res = await apiFetch(`${socialUrl()}/api/forms/me/purchases`);
      if (!res.ok) return;
      const data = (await res.json()) as { activeTags?: UserTag[] };
      activeTags = data.activeTags ?? [];
    } catch {
      // Non-blocking - section stays empty
    } finally {
      purchasesLoading = false;
    }
  }
</script>

<div
  class="border-cn-border animate-in fade-in slide-in-from-bottom-4 rounded-2xl border bg-(--cn-surface) p-6 shadow-sm delay-250 duration-500 md:p-8"
  style="animation-fill-mode: backwards;"
>
  <div class="mb-6 flex items-center justify-between">
    <div class="flex items-center gap-3">
      <div class="rounded-xl bg-emerald-500/10 p-2.5 text-emerald-600 dark:text-emerald-400">
        <Tag size={22} strokeWidth={2.5} />
      </div>
      <div>
        <h2 class="text-text-main text-lg font-extrabold">{m.profile_subs_heading()}</h2>
        <p class="text-text-muted mt-0.5 text-xs font-medium">
          {m.profile_subs_subtitle()}
        </p>
      </div>
    </div>
    <a
      href="/account/purchases"
      class="text-text-main hidden items-center gap-1.5 rounded-xl bg-black/5 px-4 py-2 text-sm font-bold transition-all hover:bg-black/10 sm:inline-flex dark:bg-white/10 dark:hover:bg-white/20"
    >
      <ShoppingBag size={16} />
      {m.profile_subs_see_all()}
      <ChevronRight size={16} />
    </a>
  </div>

  {#if purchasesLoading}
    <div class="text-text-muted flex items-center gap-3 py-2 text-sm font-semibold">
      <LoaderCircle size={18} class="animate-spin" />
      {m.common_loading_label()}
    </div>
  {:else if activeTags.length === 0}
    <p class="text-text-muted mb-4 text-sm">{m.profile_subs_empty()}</p>
  {:else}
    <ul class="mb-4 space-y-2">
      {#each activeTags as tag (tag.id)}
        <li
          class="border-cn-border flex items-center gap-3 rounded-xl border bg-white/50 px-4 py-3 dark:bg-white/5"
        >
          <CotisationTagRow {tag}>
            {#snippet trailing()}
              <span
                class="shrink-0 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-bold text-emerald-600 dark:text-emerald-400"
              >
                {m.profile_subs_active_badge()}
              </span>
            {/snippet}
          </CotisationTagRow>
        </li>
      {/each}
    </ul>
  {/if}

  <a
    href="/account/purchases"
    class="text-text-main flex w-full items-center justify-center gap-2 rounded-xl bg-black/5 px-4 py-3.5 text-sm font-bold transition-all active:scale-[0.98] sm:hidden dark:bg-white/10"
  >
    <ShoppingBag size={18} />
    {m.profile_subs_see_all_mobile()}
    <ChevronRight size={16} />
  </a>
</div>
