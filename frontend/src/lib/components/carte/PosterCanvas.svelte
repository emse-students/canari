<script lang="ts">
  import { getInitials } from '$lib/utils/avatar';
  import type { CarteTheme } from '$lib/carte/theme';
  import type { PosterModel } from '$lib/carte/generator';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    model: PosterModel;
    theme: CarteTheme;
    /** Poster title (the project name). */
    title: string;
    /** Optional background image + scrim. */
    background: { dataUrl: string | null; scrimOpacity: number };
    /** Bound to the parent so it can rasterise this exact node for PDF export. */
    el?: HTMLElement;
  }

  let { model, theme, title, background, el = $bindable() }: Props = $props();

  /** Fixed natural width of the poster (landscape A-series ratio). Export captures at this size. */
  const WIDTH = 1600;

  /** Hides a broken avatar/logo image so the colored initials layer behind it shows through. */
  function hideOnError(event: Event) {
    (event.currentTarget as HTMLImageElement).style.display = 'none';
  }

  /** Small deterministic tilt so president polaroids feel hand-placed. */
  function tilt(index: number): number {
    const steps = [-4, 3, -2, 4, -3, 2];
    return steps[index % steps.length];
  }
</script>

<!-- The poster IS the export target: fixed pixel size, absolute layers, self-contained styles. -->
<div
  bind:this={el}
  style:width="{WIDTH}px"
  style:position="relative"
  style:overflow="hidden"
  style:background={theme.pageBg}
  style:color={theme.bubbleNameColor}
  style:font-family="'Nunito Variable', 'Nunito', 'Segoe UI', sans-serif"
>
  {#if background.dataUrl}
    <img
      src={background.dataUrl}
      alt=""
      style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;"
    />
    <div
      style:position="absolute"
      style:inset="0"
      style:background={theme.scrimColor}
      style:opacity={background.scrimOpacity / 100}
    ></div>
  {/if}

  <div style="position:relative;padding:56px 56px 64px;">
    <h1
      style:font-family="'Fredoka Variable', 'Fredoka', 'Segoe UI', sans-serif"
      style:font-size="52px"
      style:font-weight="700"
      style:margin="0 0 8px"
      style:color={theme.titleColor}
    >
      {title}
    </h1>
    <p style:margin="0 0 40px" style:font-size="18px" style:opacity="0.75">
      {m.carte_poster_subtitle({ count: model.totalAssos })}
    </p>

    {#if model.totalAssos === 0}
      <p style:font-size="20px" style:opacity="0.7">{m.carte_empty()}</p>
    {/if}

    {#each model.zones as zone (zone.categoryId ?? 'none')}
      <section style="margin-bottom:44px;">
        <h2
          style:font-family="'Fredoka Variable', 'Fredoka', 'Segoe UI', sans-serif"
          style:font-size="28px"
          style:font-weight="800"
          style:margin="0 0 20px"
          style:color={theme.zoneHeadingColor}
        >
          {zone.label}
        </h2>
        <div style="display:flex;flex-wrap:wrap;gap:28px;">
          {#each zone.bubbles as bubble, i (bubble.assoId)}
            <div style="display:flex;flex-direction:column;align-items:center;width:190px;">
              <!-- Brand-color disc with the logo (initials behind as fallback). -->
              <div
                style:position="relative"
                style:width="132px"
                style:height="132px"
                style:border-radius="50%"
                style:overflow="hidden"
                style:background={bubble.color}
                style:display="flex"
                style:align-items="center"
                style:justify-content="center"
                style:color="#ffffff"
                style:font-weight="800"
                style:font-size="42px"
                style:box-shadow="0 6px 18px rgba(0,0,0,0.18)"
              >
                <span>{getInitials(bubble.name)}</span>
                {#if bubble.logoUrl}
                  <img
                    src={bubble.logoUrl}
                    alt=""
                    onerror={hideOnError}
                    style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;"
                  />
                {/if}
              </div>

              <p
                style:margin="12px 0 0"
                style:font-size="18px"
                style:font-weight="800"
                style:text-align="center"
                style:line-height="1.2"
                style:color={theme.bubbleNameColor}
              >
                {bubble.name}
              </p>

              {#if bubble.president}
                <!-- President polaroid: tilted card with avatar + name + role. -->
                <div
                  style:margin-top="14px"
                  style:background={theme.polaroidBg}
                  style:border-radius="10px"
                  style:padding="8px 8px 10px"
                  style:width="128px"
                  style:box-shadow="0 5px 14px rgba(0,0,0,0.2)"
                  style:transform="rotate({tilt(i)}deg)"
                >
                  <div
                    style:position="relative"
                    style:width="112px"
                    style:height="96px"
                    style:border-radius="6px"
                    style:overflow="hidden"
                    style:background={bubble.color}
                    style:display="flex"
                    style:align-items="center"
                    style:justify-content="center"
                    style:color="#ffffff"
                    style:font-weight="800"
                    style:font-size="30px"
                  >
                    <span>{getInitials(bubble.president.name)}</span>
                    <img
                      src={`/api/users/${encodeURIComponent(bubble.president.userId)}/avatar`}
                      alt=""
                      onerror={hideOnError}
                      style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;"
                    />
                  </div>
                  <p
                    style:margin="7px 0 0"
                    style:font-size="12.5px"
                    style:font-weight="700"
                    style:text-align="center"
                    style:line-height="1.2"
                    style:color={theme.polaroidTextColor}
                  >
                    {bubble.president.name}
                  </p>
                  <p
                    style:margin="1px 0 0"
                    style:font-size="11px"
                    style:text-align="center"
                    style:opacity="0.7"
                    style:color={theme.polaroidTextColor}
                  >
                    {bubble.president.role}
                  </p>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </section>
    {/each}

    {#if model.totalAssos > 0}
      <!-- Themed text directory grouped by zone. -->
      <section
        style:margin-top="12px"
        style:background={theme.directoryBg}
        style:border-radius="20px"
        style:padding="28px 32px"
      >
        <h2
          style:font-family="'Fredoka Variable', 'Fredoka', 'Segoe UI', sans-serif"
          style:font-size="24px"
          style:font-weight="800"
          style:margin="0 0 18px"
          style:color={theme.directoryTextColor}
        >
          {m.carte_directory_heading()}
        </h2>
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px 40px;">
          {#each model.zones as zone (zone.categoryId ?? 'none')}
            <div style="break-inside:avoid;">
              <h3
                style:font-size="15px"
                style:font-weight="800"
                style:text-transform="uppercase"
                style:letter-spacing="0.04em"
                style:margin="0 0 8px"
                style:color={theme.directoryMutedColor}
              >
                {zone.label}
              </h3>
              {#each zone.bubbles as bubble (bubble.assoId)}
                <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:5px;">
                  <span
                    style:flex="0 0 auto"
                    style:width="10px"
                    style:height="10px"
                    style:border-radius="50%"
                    style:background={bubble.color}
                    style:transform="translateY(1px)"
                  ></span>
                  <span style="font-size:14px;line-height:1.35;color:{theme.directoryTextColor};">
                    <span style="font-weight:800;">{bubble.name}</span>
                    {#if bubble.president}
                      <span style="color:{theme.directoryMutedColor};">
                        - {bubble.president.name}</span
                      >
                    {/if}
                    {#if bubble.contactEmail}
                      <span style="color:{theme.directoryMutedColor};">
                        - {bubble.contactEmail}</span
                      >
                    {/if}
                  </span>
                </div>
              {/each}
            </div>
          {/each}
        </div>
      </section>
    {/if}
  </div>
</div>
