<script lang="ts">
  import { onMount } from 'svelte';
  import { settings } from '$lib/stores/settingsStore.svelte';
  import { themeStore } from '$lib/stores/themeStore.svelte';
  import {
    Settings,
    Volume2,
    VolumeX,
    Vibrate,
    VibrateOff,
    Sun,
    Moon,
    Monitor,
    Languages,
  } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { changeLocale, getLocale, locales, LOCALE_LABELS } from '$lib/i18n';

  // The vibration toggle is only meaningful on touch-capable hardware; detect it here so the
  // section needs no props and stays drop-in.
  let isTouchDevice = $state(false);
  onMount(() => {
    isTouchDevice = window.matchMedia('(pointer: coarse)').matches;
  });
</script>

<div
  class="border-cn-border animate-in fade-in slide-in-from-bottom-4 rounded-2xl border bg-(--cn-surface) p-6 shadow-sm delay-200 duration-500 md:p-8"
  style="animation-fill-mode: backwards;"
>
  <div class="mb-6 flex items-center gap-3">
    <div class="bg-cn-yellow/10 text-cn-dark rounded-xl p-2.5">
      <Settings size={22} strokeWidth={2.5} />
    </div>
    <h2 class="text-text-main text-lg font-extrabold">{m.profile_preferences_title()}</h2>
  </div>

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
        class="focus-visible:ring-cn-yellow relative h-6 w-12 shrink-0 rounded-full transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-offset-2
          {settings.soundsEnabled ? 'bg-cn-yellow' : 'bg-black/20 dark:bg-white/15'}"
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
          class="focus-visible:ring-cn-yellow relative h-6 w-12 shrink-0 rounded-full transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-offset-2
            {settings.vibrationsEnabled ? 'bg-cn-yellow' : 'bg-black/20 dark:bg-white/15'}"
        >
          <span
            class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-md transition-transform duration-200
              {settings.vibrationsEnabled ? 'translate-x-6' : 'translate-x-0'}"
          ></span>
        </button>
      </div>
    {/if}

    <div class="flex items-center justify-between gap-4">
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
            class="focus-visible:ring-cn-yellow flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors outline-none focus-visible:ring-2
              {themeStore.preference === opt.value
              ? 'bg-cn-yellow text-cn-ink shadow'
              : 'text-text-muted hover:text-text-main'}"
          >
            <Icon size={15} strokeWidth={2.5} />
            <span class="hidden sm:inline">{opt.label}</span>
          </button>
        {/each}
      </div>
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
            class="focus-visible:ring-cn-yellow rounded-lg px-3 py-1.5 text-xs font-semibold uppercase transition-colors outline-none focus-visible:ring-2
              {getLocale() === locale
              ? 'bg-cn-yellow text-cn-ink shadow'
              : 'text-text-muted hover:text-text-main'}"
          >
            {locale}
          </button>
        {/each}
      </div>
    </div>
  </div>
</div>
