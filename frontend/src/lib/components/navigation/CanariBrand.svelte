<script lang="ts">
  interface Props {
    /** When true, hides the text on small screens. */
    compact?: boolean;
    /** Optional tagline displayed below the brand name. */
    subtitle?: string;
  }

  let { compact = false, subtitle = 'Le réseau des Marteaux' }: Props = $props();

  /** Every May 27th, a small tribute replaces the brand name. */
  const now = new Date();
  const brandName = now.getMonth() === 4 && now.getDate() === 27 ? 'À perte !' : 'Canari';
</script>

<!-- Wrapper principal pour encapsuler l'état "group" et gérer l'espacement -->
<div class="flex items-center gap-3 group select-none">
  <!-- Conteneur de l'icône -->
  <div
    class="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-[#151B2C] shadow-md shadow-black/10 border border-black/5 dark:border-white/10 overflow-hidden transition-all duration-300 group-hover:scale-105 group-hover:shadow-lg group-hover:shadow-black/20 dark:group-hover:shadow-white/5"
  >
    <!-- Le logo avec un léger effet de rotation au survol pour le dynamisme -->
    <img
      src="/favicon.png"
      alt="Logo Canari"
      class="w-[26px] h-[26px] object-contain drop-shadow-md transition-transform duration-300 group-hover:-rotate-3 group-hover:scale-110"
    />
  </div>

  <!-- Conteneur du texte -->
  <div class="leading-tight flex flex-col justify-center {compact ? 'hidden sm:flex' : 'flex'}">
    <p class="text-xl font-brand font-bold tracking-wide text-text-main capitalize transition-colors duration-300 group-hover:text-amber-500 dark:group-hover:text-amber-400">
      {brandName}
    </p>

    {#if subtitle}
      <p class="text-[11px] font-medium text-text-muted mt-[1px] opacity-80 transition-opacity duration-300 group-hover:opacity-100">
        {subtitle}
      </p>
    {/if}
  </div>
</div>
