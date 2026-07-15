<script lang="ts">
  import { Building2, ClipboardList, FileText, User } from '@lucide/svelte';
  import type { CanariLinkPreview } from '$lib/utils/canariLinkPreview';

  interface Props {
    preview: CanariLinkPreview | null;
    loading?: boolean;
  }

  let { preview, loading = false }: Props = $props();

  const Icon = $derived(
    preview?.kind === 'form'
      ? ClipboardList
      : preview?.kind === 'association'
        ? Building2
        : preview?.kind === 'profile'
          ? User
          : FileText
  );
</script>

<div
  class="shrink-0 relative overflow-hidden rounded-xl border border-black/5 dark:border-white/10 flex items-center justify-center w-16 h-16 sm:w-[4.5rem] sm:h-[4.5rem] bg-gradient-to-br from-[#151B2C] via-[#1e2848] to-amber-700/70"
>
  {#if loading}
    <div
      class="absolute inset-0 bg-black/15 dark:bg-white/10 animate-pulse"
      aria-hidden="true"
    ></div>
  {:else if preview?.imageUrl}
    <img
      src={preview.imageUrl}
      alt=""
      class="absolute inset-0 w-full h-full object-cover"
      loading="lazy"
    />
    <div
      class="absolute inset-0 bg-gradient-to-t from-black/35 via-transparent to-transparent"
      aria-hidden="true"
    ></div>
  {:else}
    <img
      src="/og-canari.png"
      alt=""
      class="absolute bottom-0 right-0 w-9 h-9 object-contain opacity-35 pointer-events-none select-none"
      aria-hidden="true"
    />
    <Icon
      size={28}
      class="text-amber-300/95 relative z-[1]"
      strokeWidth={1.75}
      aria-hidden="true"
    />
  {/if}
</div>
