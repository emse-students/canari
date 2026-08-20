<script lang="ts">
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** When true, hides the text on small screens. */
    compact?: boolean;
    /** Optional tagline displayed below the brand name. Defaults to the localized brand tagline. */
    subtitle?: string;
  }

  let { compact = false, subtitle: subtitleProp }: Props = $props();
  const subtitle = $derived(subtitleProp ?? m.brand_subtitle());

  /** Every May 27th, a small tribute replaces the brand name. */
  const now = new Date();
  const brandName = now.getMonth() === 4 && now.getDate() === 27 ? 'À perte !' : 'Canari';
</script>

<!-- Wrapper principal pour encapsuler l'état "group" et gérer l'espacement -->
<div class="group flex items-center gap-3 select-none">
  <!-- Conteneur de l'icône -->
  <div
    class="bg-cn-ink relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[14px] border border-black/5 shadow-md shadow-black/10 transition-all duration-300 group-hover:scale-105 group-hover:shadow-lg group-hover:shadow-black/20 dark:border-white/10 dark:group-hover:shadow-white/5"
  >
    <!-- Le logo avec un léger effet de rotation au survol pour le dynamisme -->
    <img
      src="/favicon.png"
      alt="Logo Canari"
      class="h-[26px] w-[26px] object-contain drop-shadow-md transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-3"
    />
  </div>

  <!-- Conteneur du texte -->
  <div class="flex flex-col justify-center leading-tight {compact ? 'hidden sm:flex' : 'flex'}">
    <p
      class="font-brand text-text-main text-xl font-bold tracking-wide capitalize transition-colors duration-300 group-hover:text-amber-500 dark:group-hover:text-amber-400"
    >
      {brandName}
    </p>

    {#if subtitle}
      <p
        class="text-text-muted mt-[1px] text-[11px] font-medium opacity-80 transition-opacity duration-300 group-hover:opacity-100"
      >
        {subtitle}
      </p>
    {/if}
  </div>
</div>
