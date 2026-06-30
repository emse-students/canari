<script lang="ts">
  import { onMount } from 'svelte';
  import { Tag, ShoppingBag, ChevronRight, Loader2 } from '@lucide/svelte';
  import { apiFetch } from '$lib/utils/apiFetch';
  import { socialUrl } from '$lib/utils/apiUrl';
  import type { UserTag } from '$lib/associations/api';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

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
  class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-6 md:p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-500 delay-250"
  style="animation-fill-mode: backwards;"
>
  <div class="flex items-center justify-between mb-6">
    <div class="flex items-center gap-3">
      <div class="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
        <Tag size={22} strokeWidth={2.5} />
      </div>
      <div>
        <h2 class="text-lg font-extrabold text-text-main">{m.profile_subs_heading()}</h2>
        <p class="text-xs font-medium text-text-muted mt-0.5">
          {m.profile_subs_subtitle()}
        </p>
      </div>
    </div>
    <a
      href="/account/purchases"
      class="hidden sm:inline-flex items-center gap-1.5 rounded-xl bg-black/5 dark:bg-white/10 px-4 py-2 text-sm font-bold text-text-main hover:bg-black/10 dark:hover:bg-white/20 transition-all"
    >
      <ShoppingBag size={16} />
      {m.profile_subs_see_all()}
      <ChevronRight size={16} />
    </a>
  </div>

  {#if purchasesLoading}
    <div class="flex items-center gap-3 text-sm font-semibold text-text-muted py-2">
      <Loader2 size={18} class="animate-spin" />
      {m.common_loading_label()}
    </div>
  {:else if activeTags.length === 0}
    <p class="text-sm text-text-muted mb-4">{m.profile_subs_empty()}</p>
  {:else}
    <ul class="space-y-2 mb-4">
      {#each activeTags as tag (tag.id)}
        <li
          class="flex items-center gap-3 rounded-xl border border-cn-border bg-white/50 dark:bg-white/5 px-4 py-3"
        >
          <div class="min-w-0 flex-1">
            <p class="text-sm font-bold text-text-main">{tag.tagName}</p>
            <p class="text-xs text-text-muted mt-0.5">
              {#if tag.expiresAt}
                {m.profile_subs_expires_at({
                  date: new Date(tag.expiresAt).toLocaleDateString(
                    getLocale() === 'en' ? 'en-US' : 'fr-FR'
                  ),
                })}
              {:else}
                {m.profile_subs_no_expiry()}
              {/if}
            </p>
          </div>
          <span
            class="shrink-0 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-2.5 py-0.5 text-xs font-bold"
          >
            {m.profile_subs_active_badge()}
          </span>
        </li>
      {/each}
    </ul>
  {/if}

  <a
    href="/account/purchases"
    class="sm:hidden w-full flex items-center justify-center gap-2 rounded-xl bg-black/5 dark:bg-white/10 px-4 py-3.5 text-sm font-bold text-text-main active:scale-[0.98] transition-all"
  >
    <ShoppingBag size={18} />
    {m.profile_subs_see_all_mobile()}
    <ChevronRight size={16} />
  </a>
</div>
