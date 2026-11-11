<script lang="ts">
  import { FlaskConical } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { isNonProductionDeployment } from '$lib/utils/deployEnvironment';
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

  /**
   * Every May 27th, a small tribute replaces the brand name. The tribute is a French motto and stays
   * French in every locale, but it is a user-visible string, so it lives in the message catalogue.
   */
  const now = new Date();
  const brandName =
    now.getMonth() === 4 && now.getDate() === 27 ? m.brand_tribute_name() : 'Canari';

  const showEnvironmentBadge = isNonProductionDeployment();

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
      // A ROOM OF 0px IS A HEADER THAT IS NOT LAID OUT, NOT ONE THE NAME OVERFLOWS. `MobileHeader` is
      // `md:hidden` and re-mounts every time a conversation closes, so on a desktop each re-mount
      // measured `display: none`, hid the name of a header nobody sees and logged it - a line that
      // landed beside every salon tap and read as a layout fault (2026-10-12 console export). No
      // verdict until there is a width; the ResizeObserver measures again the moment it shows.
      if (room.clientWidth === 0) return;
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
  <!-- The wrapper is the icon's box, so the badge can sit on its corner outside the icon's own
       `overflow-hidden`. It is the first child the fit measurement reads: still 40px wide. -->
  <div class="relative h-10 w-10 shrink-0">
    <!-- Conteneur de l'icône -->
    <div
      class="bg-cn-ink relative flex h-10 w-10 items-center justify-center overflow-hidden rounded-2xl border border-black/5 shadow-md shadow-black/10 transition-all duration-300 group-hover:scale-105 group-hover:shadow-lg group-hover:shadow-black/20 dark:border-white/10 dark:group-hover:shadow-white/5"
    >
      <!-- Le logo avec un léger effet de rotation au survol pour le dynamisme -->
      <img
        src="/favicon.png"
        alt="Logo Canari"
        class="h-[26px] w-[26px] object-contain drop-shadow-md transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-3"
      />
    </div>
    <!-- THE TEST-ENVIRONMENT MARK (owner, 2026-11-11). It replaced a full-width banner that cost a
         row on every screen and, on the camera screen, sat under the iOS status bar. A badge on the
         logo costs no space, so it is not dismissible. It stays OFF the avatar: that ring is the
         connection indicator. A build-time fact, so it is up before the first request. -->
    {#if showEnvironmentBadge}
      <span
        data-testid="environment-badge"
        role="img"
        title={m.env_banner_test_label()}
        aria-label={m.env_banner_test_label()}
        class="bg-banner-info absolute -top-1 -left-1 flex h-4 w-4 items-center justify-center rounded-full border-2 border-(--surface-elevated) text-white shadow-sm"
      >
        <FlaskConical size={9} aria-hidden="true" />
      </span>
    {/if}
  </div>

  <!--
    Conteneur du texte. OPTICALLY CENTRED ON THE ICON: each line box is trimmed to its glyphs, so the
    block's top edge is the cap top of the name and its bottom edge the baseline of the tagline, and
    `min-h-10` (the icon's height) with `justify-between` pins those two edges to the icon's. A
    line box otherwise adds space above the cap height and below the baseline (the half-leading
    plus the font's ascender and descender gaps), which pushed the block 1.5px low at the default
    size. Without a tagline the trimmed name is simply centred. The trim is `text-box: trim-both
    cap alphabetic` written out in `em`, because Firefox has not shipped that property.
  -->
  <div
    bind:this={nameBlock}
    aria-hidden={fitContainer && !nameFits ? 'true' : undefined}
    class="flex min-h-10 flex-col whitespace-nowrap {subtitle
      ? 'justify-between'
      : 'justify-center'} {compact
      ? 'hidden sm:flex'
      : fitContainer && !nameFits
        ? 'invisible absolute'
        : 'flex'}"
  >
    <!-- Fredoka Variable 700: ascender 0.974em, descender 0.236em, cap height 0.703em. With
         line-height 1 the cap top sits 0.166em below the line box top and the baseline 0.131em
         above its bottom (measured from canvas metrics at 1000px, 2026-10-31). -->
    <p
      class="font-brand text-text-main group-hover:text-accent-text -mt-[0.166em] -mb-[0.131em] text-xl leading-none font-bold capitalize transition-colors duration-300"
    >
      {brandName}
    </p>

    {#if subtitle}
      <!-- Nunito Variable 500: ascender 1.011em, descender 0.353em, cap height 0.719em, so the cap
           top is 0.110em below the line box top and the baseline 0.171em above its bottom. -->
      <p
        class="text-text-muted text-2xs -mt-[0.11em] -mb-[0.171em] leading-none font-medium opacity-80 transition-opacity duration-300 group-hover:opacity-100"
      >
        {subtitle}
      </p>
    {/if}
  </div>
</div>
