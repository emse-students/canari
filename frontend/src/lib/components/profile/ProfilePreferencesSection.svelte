<script lang="ts">
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

  interface Props {
    /** Whether the device is touch-capable (shows the vibration toggle). */
    isTouchDevice: boolean;
  }

  let { isTouchDevice }: Props = $props();

</script>

<div
  class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-6 md:p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-500 delay-200"
  style="animation-fill-mode: backwards;"
>
  <div class="flex items-center gap-3 mb-6">
    <div class="p-2.5 rounded-xl bg-cn-yellow/10 text-cn-dark">
      <Settings size={22} strokeWidth={2.5} />
    </div>
    <h2 class="text-lg font-extrabold text-text-main">{m.profile_preferences_title()}</h2>
  </div>

  <div class="space-y-5">
    <div class="flex items-center justify-between gap-4">
      <div class="flex items-center gap-3.5">
        <div class="p-2.5 rounded-xl bg-black/5 dark:bg-black/40 text-text-muted">
          {#if settings.soundsEnabled}
            <Volume2 size={20} strokeWidth={2.5} />
          {:else}
            <VolumeX size={20} strokeWidth={2.5} />
          {/if}
        </div>
        <div>
          <p class="text-sm font-bold text-text-main">{m.profile_bruitages()}</p>
          <p class="text-xs font-medium text-text-muted mt-0.5">
            {m.profile_bruitages_desc()}
          </p>
        </div>
      </div>

      <button
        role="switch"
        aria-checked={settings.soundsEnabled}
        aria-label={m.profile_pref_sounds_aria()}
        onclick={() => settings.setSoundsEnabled(!settings.soundsEnabled)}
        class="relative shrink-0 w-12 h-6 rounded-full transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-cn-yellow focus-visible:ring-offset-2
          {settings.soundsEnabled ? 'bg-cn-yellow' : 'bg-black/20 dark:bg-white/15'}"
      >
        <span
          class="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-md transition-transform duration-200
            {settings.soundsEnabled ? 'translate-x-6' : 'translate-x-0'}"
        ></span>
      </button>
    </div>

    {#if isTouchDevice}
      <div class="flex items-center justify-between gap-4">
        <div class="flex items-center gap-3.5">
          <div class="p-2.5 rounded-xl bg-black/5 dark:bg-black/40 text-text-muted">
            {#if settings.vibrationsEnabled}
              <Vibrate size={20} strokeWidth={2.5} />
            {:else}
              <VibrateOff size={20} strokeWidth={2.5} />
            {/if}
          </div>
          <div>
            <p class="text-sm font-bold text-text-main">{m.profile_vibrations()}</p>
            <p class="text-xs font-medium text-text-muted mt-0.5">
              {m.profile_vibrations_desc()}
            </p>
          </div>
        </div>

        <button
          role="switch"
          aria-checked={settings.vibrationsEnabled}
          aria-label={m.profile_pref_vibrations_aria()}
          onclick={() => settings.setVibrationsEnabled(!settings.vibrationsEnabled)}
          class="relative shrink-0 w-12 h-6 rounded-full transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-cn-yellow focus-visible:ring-offset-2
            {settings.vibrationsEnabled ? 'bg-cn-yellow' : 'bg-black/20 dark:bg-white/15'}"
        >
          <span
            class="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-md transition-transform duration-200
              {settings.vibrationsEnabled ? 'translate-x-6' : 'translate-x-0'}"
          ></span>
        </button>
      </div>
    {/if}

    <div class="flex items-center justify-between gap-4">
      <div class="flex items-center gap-3.5">
        <div class="p-2.5 rounded-xl bg-black/5 dark:bg-black/40 text-text-muted">
          {#if themeStore.preference === 'light'}
            <Sun size={20} strokeWidth={2.5} />
          {:else if themeStore.preference === 'dark'}
            <Moon size={20} strokeWidth={2.5} />
          {:else}
            <Monitor size={20} strokeWidth={2.5} />
          {/if}
        </div>
        <div>
          <p class="text-sm font-bold text-text-main">{m.profile_theme()}</p>
          <p class="text-xs font-medium text-text-muted mt-0.5">{m.profile_theme_desc()}</p>
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
            class="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-cn-yellow
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
        <div class="p-2.5 rounded-xl bg-black/5 dark:bg-black/40 text-text-muted">
          <Languages size={20} strokeWidth={2.5} />
        </div>
        <div>
          <p class="text-sm font-bold text-text-main">{m.settings_language_label()}</p>
          <p class="text-xs font-medium text-text-muted mt-0.5">{m.settings_language_desc()}</p>
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
            onclick={() => changeLocale(locale)}
            class="rounded-lg px-3 py-1.5 text-xs font-semibold uppercase outline-none transition-colors focus-visible:ring-2 focus-visible:ring-cn-yellow
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
