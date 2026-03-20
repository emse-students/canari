<script lang="ts">
  interface Props {
    compact?: boolean;
    subtitle?: string;
  }

  let { compact = false, subtitle = 'messagerie + fil social' }: Props = $props();
</script>

<div
  class="relative flex h-10 w-10 items-center justify-center rounded-2xl bg-[oklch(37.2%_0.044_257.287)] shadow-sm border border-black/5 dark:border-white/10 overflow-hidden group-hover:scale-105 transition-transform duration-300"
>
  <img src="/favicon.png" alt="Canari Logo" class="w-7 h-7 object-contain drop-shadow-sm" />
</div>
<div class="leading-tight {compact ? 'hidden sm:block' : ''}">
  <p class="text-xl font-brand font-bold tracking-wide text-cn-dark dark:text-white capitalize">
    Canari
  </p>
  <p class="text-[11px] font-medium text-text-muted mt-[2px] opacity-80">{subtitle}</p>
</div>
