<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

  interface Props {
    /** When true, hides the text on small screens. */
    compact?: boolean;
    /**
     * When true, the name is drawn only if the parent element leaves it room, MEASURED (see the
     * effect below), and the bird alone otherwise. For a header whose controls vary by route: at
     * 360px the phone header's five feed controls leave the brand 100px.
     */
    fitContainer?: boolean;
    /** Optional tagline displayed below the brand name. Defaults to the localized brand tagline. */
    subtitle?: string;
  }

  let { compact = false, fitContainer = false, subtitle: subtitleProp }: Props = $props();
  const subtitle = $derived(subtitleProp ?? m.brand_subtitle());

  /** Every May 27th, a small tribute replaces the brand name. */
  const now = new Date();
  const brandName = now.getMonth() === 4 && now.getDate() === 27 ? 'À perte !' : 'Canari';

  let brandRow = $state<HTMLDivElement | null>(null);
  let nameBlock = $state<HTMLDivElement | null>(null);
  let nameFits = $state(true);

  /**
   * `fitContainer` decides from the name's MEASURED width, not a length in the stylesheet.
   *
   * It was a container query at 8rem, the name's width at the default text size - and that stops
   * being true the moment the system text size changes. Android's WebView scales every font size
   * with it (measured on the Mi 9T at 200 %, 2026-09-30: a `20px` declaration computes to `40px`,
   * `text-size-adjust: none` changes nothing) while a `rem` LENGTH stays put (`8rem` = 128px). The
   * query kept answering "it fits" for a name that had grown to 146px, and the name ran over the
   * `+` beside it. The name is laid out even when it is not shown (`invisible absolute`), so its
   * width is always there to read.
   */
  $effect(() => {
    const row = brandRow;
    const name = nameBlock;
    const room = row?.parentElement;
    if (!fitContainer || !row || !name || !room) return;
    const measure = () => {
      const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
      const bird = row.firstElementChild?.getBoundingClientRect().width ?? 0;
      const fits = bird + gap + name.scrollWidth <= room.clientWidth;
      if (fits !== nameFits) {
        Log.d(`CanariBrand: name ${fits ? 'fits' : 'does not fit'} in ${room.clientWidth}px`);
        nameFits = fits;
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(room);
    ro.observe(name);
    return () => ro.disconnect();
  });
</script>

<!-- Wrapper principal pour encapsuler l'état "group" et gérer l'espacement -->
<div bind:this={brandRow} class="group relative flex items-center gap-3 select-none">
  <!-- Conteneur de l'icône -->
  <div
    class="bg-cn-ink relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-black/5 shadow-md shadow-black/10 transition-all duration-300 group-hover:scale-105 group-hover:shadow-lg group-hover:shadow-black/20 dark:border-white/10 dark:group-hover:shadow-white/5"
  >
    <!-- Le logo avec un léger effet de rotation au survol pour le dynamisme -->
    <img
      src="/favicon.png"
      alt="Logo Canari"
      class="h-[26px] w-[26px] object-contain drop-shadow-md transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-3"
    />
  </div>

  <!-- Conteneur du texte -->
  <div
    bind:this={nameBlock}
    aria-hidden={fitContainer && !nameFits ? 'true' : undefined}
    class="flex flex-col justify-center gap-0.5 whitespace-nowrap {compact
      ? 'hidden sm:flex'
      : fitContainer && !nameFits
        ? 'invisible absolute'
        : 'flex'}"
  >
    <p
      class="font-brand text-text-main text-xl font-bold tracking-wide capitalize transition-colors duration-300 group-hover:text-amber-500 dark:group-hover:text-amber-400"
    >
      {brandName}
    </p>

    {#if subtitle}
      <p
        class="text-text-muted text-2xs mt-[1px] font-medium opacity-80 transition-opacity duration-300 group-hover:opacity-100"
      >
        {subtitle}
      </p>
    {/if}
  </div>
</div>
