<script lang="ts">
  import { onMount } from 'svelte';
  import { settings } from '$lib/stores/settingsStore.svelte';
  import { themeStore } from '$lib/stores/themeStore.svelte';
  import {
    Volume2,
    VolumeX,
    Vibrate,
    VibrateOff,
    Sun,
    Moon,
    Monitor,
    Languages,
    Share2,
    Compass,
    Lightbulb,
    Smile,
    Play,
  } from '@lucide/svelte';
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import { Log } from '$lib/utils/Log';
  import {
    offeredVideoAutoplayModes,
    videoAutoplayMode,
    type VideoAutoplayMode,
  } from '$lib/video/autoplayPolicy';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { replayGuide } from '$lib/guidance/guidance.svelte';
  import { GUIDES } from '$lib/guidance/guides';
  import type { GuideDefinition } from '$lib/guidance/guideTypes';
  import { m } from '$lib/paraglide/messages';
  import { changeLocale, getLocale, locales, LOCALE_LABELS } from '$lib/i18n';
  import { isCoarsePointerDevice } from '$lib/utils/pointerDevice';
  import { isMobileTauriRuntime } from '$lib/utils/appVersion';
  import RepostConsentSetting from './RepostConsentSetting.svelte';
  import ActivitySharingSetting from './ActivitySharingSetting.svelte';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
  import {
    EMOJI_STYLES,
    currentEmojiStyle,
    setEmojiStyle,
    type EmojiStyle,
  } from '$lib/utils/emojiStyle';

  /** The label of each autoplay choice, in the order `VIDEO_AUTOPLAY_MODES` lists them. */
  const VIDEO_AUTOPLAY_LABELS: Record<VideoAutoplayMode, () => string> = {
    always: m.settings_video_autoplay_always,
    wifi: m.settings_video_autoplay_wifi,
    never: m.settings_video_autoplay_never,
  };

  /**
   * This device's autoplay mode as it applies - a "wifi" stored on a device that cannot tell its link
   * is drawn as Jamais, which is what it does (owner, 2026-11-11).
   */
  const autoplayMode = $derived(videoAutoplayMode());
  /** The choices this device can honour: no "Wi-Fi" where the engine reports no link. */
  const autoplayModes = $derived(offeredVideoAutoplayModes());

  /** "Lecture automatique des vidéos" (owner, 2026-11-10): kept per device, applied at the next start. */
  function setVideoAutoplay(mode: VideoAutoplayMode) {
    Log.d('SETTINGS', `video autoplay: ${mode}`);
    settings.setVideoAutoplay(mode);
  }

  /** "Défilement infini des CanaReels" (owner, 2026-11-10): read at the next feed video opened. */
  function setInfiniteReels(enabled: boolean) {
    Log.d('SETTINGS', `infinite CanaReels: ${enabled ? 'on' : 'off'}`);
    settings.setInfiniteReelsEnabled(enabled);
  }

  /** The label of each emoji choice, in the order `EMOJI_STYLES` lists them. */
  const EMOJI_STYLE_LABELS: Record<EmojiStyle, () => string> = {
    system: m.settings_emoji_style_system,
    canari: m.settings_emoji_style_canari,
  };

  // The vibration toggle is only meaningful on touch-capable hardware; detect it here so the
  // section needs no props and stays drop-in.
  let isTouchDevice = $state(false);
  // Share suggestions (sharing lot S5) exist only in the phone apps' share sheets: the toggle is
  // hidden wherever it would do nothing.
  let isPhoneApp = $state(false);
  /**
   * Replays the welcome tour: it runs on the feed, where every control it points at is drawn, so the
   * request is recorded first and the feed opened - the tour starts there once the app is quiet.
   */
  function replayWelcomeTour() {
    replayGuide('welcome-tour');
    void goto(resolve('/posts'));
  }

  /** The hints a reader may replay: those declaring a `replay` (label and route). */
  const REPLAYABLE_HINTS = GUIDES.filter((g) => g.replay);

  /** Replays one hint: the request is recorded, then its page is opened - it starts there. */
  function replayHint(hint: GuideDefinition) {
    replayGuide(hint.id);
    void goto(resolve(hint.replay!.route));
  }

  onMount(() => {
    isTouchDevice = isCoarsePointerDevice();
    isPhoneApp = isMobileTauriRuntime();
  });
</script>

<div
  class="border-cn-border animate-in fade-in slide-in-from-bottom-4 rounded-2xl border bg-(--cn-surface) p-6 shadow-sm delay-200 duration-500 md:p-8"
  style="animation-fill-mode: backwards;"
>
  <h2 class="sr-only">{m.profile_preferences_title()}</h2>

  <div class="space-y-5">
    <div class="flex items-center justify-between gap-4">
      <div class="flex items-center gap-3.5">
        <div class="text-text-muted rounded-xl bg-black/5 p-2.5 dark:bg-black/40">
          {#if settings.soundsEnabled}
            <Volume2 size={20} strokeWidth={2.5} />
          {:else}
            <VolumeX size={20} strokeWidth={2.5} />
          {/if}
        </div>
        <div>
          <p class="text-text-main text-sm font-bold">{m.profile_bruitages()}</p>
          <p class="text-text-muted mt-0.5 text-xs font-medium">
            {m.profile_bruitages_desc()}
          </p>
        </div>
      </div>

      <button
        role="switch"
        aria-checked={settings.soundsEnabled}
        aria-label={m.profile_pref_sounds_aria()}
        onclick={() => settings.setSoundsEnabled(!settings.soundsEnabled)}
        class="focus-visible:ring-accent-icon relative h-6 w-12 shrink-0 rounded-full transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-offset-2
 {settings.soundsEnabled ? 'bg-accent' : 'bg-black/20 dark:bg-white/15'}"
      >
        <span
          class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-md transition-transform duration-200
 {settings.soundsEnabled ? 'translate-x-6' : 'translate-x-0'}"
        ></span>
      </button>
    </div>

    {#if isTouchDevice}
      <div class="flex items-center justify-between gap-4">
        <div class="flex items-center gap-3.5">
          <div class="text-text-muted rounded-xl bg-black/5 p-2.5 dark:bg-black/40">
            {#if settings.vibrationsEnabled}
              <Vibrate size={20} strokeWidth={2.5} />
            {:else}
              <VibrateOff size={20} strokeWidth={2.5} />
            {/if}
          </div>
          <div>
            <p class="text-text-main text-sm font-bold">{m.profile_vibrations()}</p>
            <p class="text-text-muted mt-0.5 text-xs font-medium">
              {m.profile_vibrations_desc()}
            </p>
          </div>
        </div>

        <button
          role="switch"
          aria-checked={settings.vibrationsEnabled}
          aria-label={m.profile_pref_vibrations_aria()}
          onclick={() => settings.setVibrationsEnabled(!settings.vibrationsEnabled)}
          class="focus-visible:ring-accent-icon relative h-6 w-12 shrink-0 rounded-full transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-offset-2
 {settings.vibrationsEnabled ? 'bg-accent' : 'bg-black/20 dark:bg-white/15'}"
        >
          <span
            class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-md transition-transform duration-200
 {settings.vibrationsEnabled ? 'translate-x-6' : 'translate-x-0'}"
          ></span>
        </button>
      </div>
    {/if}

    {#if isPhoneApp}
      <div class="flex items-center justify-between gap-4">
        <div class="flex items-center gap-3.5">
          <div class="text-text-muted rounded-xl bg-black/5 p-2.5 dark:bg-black/40">
            <Share2 size={20} strokeWidth={2.5} />
          </div>
          <div>
            <p class="text-text-main text-sm font-bold">{m.settings_share_suggestions()}</p>
            <p class="text-text-muted mt-0.5 text-xs font-medium">
              {m.settings_share_suggestions_desc()}
            </p>
          </div>
        </div>

        <button
          role="switch"
          aria-checked={settings.shareSuggestionsEnabled}
          aria-label={m.settings_share_suggestions_aria()}
          onclick={() => settings.setShareSuggestionsEnabled(!settings.shareSuggestionsEnabled)}
          class="focus-visible:ring-accent-icon relative h-6 w-12 shrink-0 rounded-full transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-offset-2
 {settings.shareSuggestionsEnabled ? 'bg-accent' : 'bg-black/20 dark:bg-white/15'}"
        >
          <span
            class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-md transition-transform duration-200
 {settings.shareSuggestionsEnabled ? 'translate-x-6' : 'translate-x-0'}"
          ></span>
        </button>
      </div>
    {/if}

    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div class="flex items-center gap-3.5">
        <div class="text-text-muted rounded-xl bg-black/5 p-2.5 dark:bg-black/40">
          {#if themeStore.preference === 'light'}
            <Sun size={20} strokeWidth={2.5} />
          {:else if themeStore.preference === 'dark'}
            <Moon size={20} strokeWidth={2.5} />
          {:else}
            <Monitor size={20} strokeWidth={2.5} />
          {/if}
        </div>
        <div>
          <p class="text-text-main text-sm font-bold">{m.profile_theme()}</p>
          <p class="text-text-muted mt-0.5 text-xs font-medium">{m.profile_theme_desc()}</p>
        </div>
      </div>

      <div
        role="radiogroup"
        aria-label={m.profile_pref_theme_aria()}
        class="flex shrink-0 items-center gap-1 rounded-xl bg-black/5 p-1 dark:bg-white/10"
      >
        {#each [{ value: 'system', label: m.profile_system(), Icon: Monitor }, { value: 'light', label: m.profile_light(), Icon: Sun }, { value: 'dark', label: m.profile_dark(), Icon: Moon }] as opt (opt.value)}
          {@const Icon = opt.Icon}
          <button
            type="button"
            role="radio"
            aria-checked={themeStore.preference === opt.value}
            aria-label={opt.label}
            title={opt.label}
            onclick={() => themeStore.setPreference(opt.value as 'system' | 'light' | 'dark')}
            class="focus-visible:ring-accent-icon flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors outline-none focus-visible:ring-2
 {themeStore.preference === opt.value
              ? 'bg-accent text-on-accent shadow'
              : 'text-text-muted hover:text-text-main'}"
          >
            <Icon size={15} strokeWidth={2.5} />
            <span>{opt.label}</span>
          </button>
        {/each}
      </div>
    </div>

    <div class="flex items-center justify-between gap-4">
      <div class="flex items-center gap-3.5">
        <div class="text-text-muted rounded-xl bg-black/5 p-2.5 dark:bg-black/40">
          <Smile size={20} strokeWidth={2.5} />
        </div>
        <div>
          <p class="text-text-main text-sm font-bold">{m.settings_emoji_style_label()}</p>
          <p class="text-text-muted mt-0.5 text-xs font-medium">
            {m.settings_emoji_style_desc()}
          </p>
        </div>
      </div>

      <SegmentedControl
        items={EMOJI_STYLES.map((style) => ({ key: style, label: EMOJI_STYLE_LABELS[style]() }))}
        value={currentEmojiStyle()}
        onSelect={setEmojiStyle}
        label={m.settings_emoji_style_label()}
        tone="yellow"
        class="w-44 shrink-0"
      />
    </div>

    <RepostConsentSetting />

    <ActivitySharingSetting />

    <div data-infinite-reels-setting>
      <Toggle
        checked={settings.infiniteReelsEnabled}
        label={m.settings_infinite_reels_label()}
        hint={m.settings_infinite_reels_hint()}
        onchange={setInfiniteReels}
      />
    </div>

    <div
      class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
      data-video-autoplay-setting
    >
      <div class="flex items-center gap-3.5">
        <div class="text-text-muted rounded-xl bg-black/5 p-2.5 dark:bg-black/40">
          <Play size={20} strokeWidth={2.5} />
        </div>
        <div>
          <p class="text-text-main text-sm font-bold">{m.settings_video_autoplay_label()}</p>
          <p class="text-text-muted mt-0.5 text-xs font-medium">
            {m.settings_video_autoplay_desc()}
          </p>
        </div>
      </div>

      <SegmentedControl
        items={autoplayModes.map((mode) => ({
          key: mode,
          label: VIDEO_AUTOPLAY_LABELS[mode](),
        }))}
        value={autoplayMode}
        onSelect={setVideoAutoplay}
        label={m.settings_video_autoplay_label()}
        tone="yellow"
        class="w-full shrink-0 sm:w-64"
      />
    </div>

    <div class="flex items-center justify-between gap-4">
      <div class="flex items-center gap-3.5">
        <div class="text-text-muted rounded-xl bg-black/5 p-2.5 dark:bg-black/40">
          <Languages size={20} strokeWidth={2.5} />
        </div>
        <div>
          <p class="text-text-main text-sm font-bold">{m.settings_language_label()}</p>
          <p class="text-text-muted mt-0.5 text-xs font-medium">{m.settings_language_desc()}</p>
        </div>
      </div>

      <div
        role="radiogroup"
        aria-label={m.settings_language_label()}
        class="flex shrink-0 items-center gap-1 rounded-xl bg-black/5 p-1 dark:bg-white/10"
      >
        {#each locales as locale (locale)}
          <button
            type="button"
            role="radio"
            aria-checked={getLocale() === locale}
            aria-label={LOCALE_LABELS[locale]}
            title={LOCALE_LABELS[locale]}
            onclick={() => void changeLocale(locale)}
            class="focus-visible:ring-accent-icon rounded-lg px-3 py-1.5 text-xs font-semibold uppercase transition-colors outline-none focus-visible:ring-2
 {getLocale() === locale
              ? 'bg-accent text-on-accent shadow'
              : 'text-text-muted hover:text-text-main'}"
          >
            {locale}
          </button>
        {/each}
      </div>
    </div>

    <div class="flex items-center justify-between gap-4">
      <div class="flex items-center gap-3.5">
        <div class="text-text-muted rounded-xl bg-black/5 p-2.5 dark:bg-black/40">
          <Compass size={20} strokeWidth={2.5} />
        </div>
        <div>
          <p class="text-text-main text-sm font-bold">{m.guide_replay_label()}</p>
          <p class="text-text-muted mt-0.5 text-xs font-medium">{m.guide_replay_desc()}</p>
        </div>
      </div>

      <button
        type="button"
        onclick={replayWelcomeTour}
        data-guide-replay="welcome-tour"
        class="border-cn-border text-text-main hover:bg-text-main/10 focus-visible:ring-accent-icon shrink-0 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors outline-none focus-visible:ring-2"
      >
        {m.guide_replay_button()}
      </button>
    </div>

    <div class="flex flex-col gap-3">
      <div class="flex items-center gap-3.5">
        <div class="text-text-muted rounded-xl bg-black/5 p-2.5 dark:bg-black/40">
          <Lightbulb size={20} strokeWidth={2.5} />
        </div>
        <div>
          <p class="text-text-main text-sm font-bold">{m.guide_replay_hints_label()}</p>
          <p class="text-text-muted mt-0.5 text-xs font-medium">{m.guide_replay_hints_desc()}</p>
        </div>
      </div>
      <div class="flex flex-wrap gap-2">
        {#each REPLAYABLE_HINTS as hint (hint.id)}
          <button
            type="button"
            onclick={() => replayHint(hint)}
            data-guide-replay={hint.id}
            class="border-cn-border text-text-main hover:bg-text-main/10 focus-visible:ring-accent-icon rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors outline-none focus-visible:ring-2"
          >
            {hint.replay!.label()}
          </button>
        {/each}
      </div>
    </div>
  </div>
</div>
