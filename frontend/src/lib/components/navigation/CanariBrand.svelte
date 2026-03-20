<script lang="ts">
  interface Props {
    compact?: boolean;
    subtitle?: string;
  }

  let { compact = false, subtitle = 'messagerie + fil social' }: Props = $props();
</script>

<a href="/chat" class="flex items-center gap-2 text-text-main group hover:opacity-90 transition-opacity">
  <div class="relative flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-cn-yellow to-cn-yellow-hover shadow-sm border border-black/5 dark:border-white/10 overflow-hidden group-hover:scale-105 transition-transform duration-300">
    <img src="/favicon.png" alt="Canari Logo" class="w-7 h-7 object-contain drop-shadow-sm" />
  </div>
  <div class="leading-tight {compact ? 'hidden sm:block' : ''}">
    <p class="text-xl font-brand font-bold tracking-wide text-cn-dark dark:text-white capitalize">Canari</p>
    <p class="text-[11px] font-medium text-text-muted mt-[2px] opacity-80">{subtitle}</p>
  </div>
</a>
