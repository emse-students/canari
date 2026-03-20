<script lang="ts">
  interface Props {
    compact?: boolean;
    subtitle?: string;
  }

  let { compact = false, subtitle = 'messagerie + fil social' }: Props = $props();
</script>

<a href="/chat" class="flex items-center gap-2 text-text-main">
  <span
    class="inline-flex h-9 w-9 items-center justify-center rounded-2xl bg-cn-dark text-sm font-black text-white"
    >C</span
  >
  <div class="leading-tight {compact ? 'hidden sm:block' : ''}">
    <p class="text-sm font-black tracking-[0.08em] uppercase">Canari</p>
    <p class="text-[11px] text-text-muted">{subtitle}</p>
  </div>
</a>
