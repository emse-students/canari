<script lang="ts">
  import { Check, LoaderCircle, PenLine, UserRound } from '@lucide/svelte';
  import { fade, slide } from 'svelte/transition';
  import { Log } from '$lib/utils/Log';
  import { updateMyProfile, type UserProfile } from '$lib/stores/user';
  import ProfileBioMarkdown from '$lib/components/profile/ProfileBioMarkdown.svelte';
  import MarkdownComposerField from '$lib/components/shared/MarkdownComposerField.svelte';
  import { trimComposerText } from '$lib/utils/markdown/composerText';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    profile: UserProfile;
    /** Hands the saved profile back to whoever owns it (the layout's model). */
    onSaved: (profile: UserProfile) => void;
  }

  let { profile, onSaved }: Props = $props();

  let editing = $state(false);
  let input = $state('');
  let saving = $state(false);
  let error = $state('');

  function startEdit() {
    input = profile.bio || '';
    editing = true;
  }

  function cancelEdit() {
    editing = false;
    input = profile.bio || '';
  }

  async function save() {
    saving = true;
    error = '';
    try {
      input = trimComposerText(input);
      onSaved(await updateMyProfile({ bio: input }));
      editing = false;
    } catch (err) {
      Log.d('profile.saveBio failed', err);
      error = m.profile_bio_save_error_fallback();
    } finally {
      saving = false;
    }
  }
</script>

<div
  class="border-cn-border animate-in fade-in slide-in-from-bottom-4 rounded-2xl border bg-(--cn-surface) p-6 shadow-sm duration-500 md:p-8"
>
  <div class="mb-4 flex items-center justify-between">
    <div class="flex items-center gap-3">
      <div class="bg-cn-yellow/10 text-cn-dark rounded-xl p-2.5">
        <UserRound size={22} strokeWidth={2.5} />
      </div>
      <h2 class="text-text-main text-lg font-bold">{m.profile_bio_heading()}</h2>
    </div>
    {#if !editing}
      <button
        onclick={startEdit}
        class="text-text-muted hover:text-cn-dark focus-visible:ring-cn-yellow inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-sm font-bold transition-all outline-none hover:bg-black/5 focus-visible:ring-2 active:scale-95 dark:hover:bg-white/10"
      >
        <PenLine size={16} strokeWidth={2.5} />
        {m.common_edit_label()}
      </button>
    {/if}
  </div>

  {#if error}
    <p class="mb-3 text-sm font-medium text-red-600 dark:text-red-400" role="alert">{error}</p>
  {/if}

  {#if editing}
    <div transition:slide={{ duration: 200 }} class="space-y-3">
      <MarkdownComposerField
        bind:value={input}
        maxlength={500}
        minHeight="100px"
        class="focus-within:border-cn-yellow/50 focus-within:ring-cn-yellow/30 bg-cn-surface w-full min-w-0 overflow-hidden rounded-2xl border border-black/10 shadow-inner transition-all focus-within:ring-2 dark:border-white/10"
        editorClass="min-h-[100px] w-full max-w-full px-4 py-3 text-sm text-text-main leading-relaxed"
        placeholder={m.profile_bio_placeholder()}
      />
      <div class="flex items-center justify-between">
        <span
          class="text-text-muted pl-1 text-xs font-semibold {input.length >= 490
            ? 'text-orange-500'
            : ''}"
        >
          {input.length} / 500
        </span>
        <div class="flex gap-2">
          <button
            onclick={cancelEdit}
            class="text-text-muted hover:text-text-main focus-visible:ring-text-muted rounded-xl px-4 py-2 text-sm font-bold transition-all outline-none hover:bg-black/5 focus-visible:ring-2 active:scale-95 dark:hover:bg-white/5"
          >
            {m.common_cancel_button()}
          </button>
          <button
            onclick={save}
            disabled={saving || input.trim() === profile.bio}
            class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover shadow-cn-yellow/20 focus-visible:ring-cn-yellow/50 inline-flex items-center gap-2 rounded-xl px-5 py-2 text-sm font-bold shadow-md transition-all outline-none focus-visible:ring-2 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
          >
            {#if saving}
              <LoaderCircle size={16} class="animate-spin" strokeWidth={3} />
              {m.common_saving_label()}
            {:else}
              <Check size={16} strokeWidth={3} /> {m.common_save_button()}
            {/if}
          </button>
        </div>
      </div>
    </div>
  {:else}
    <div transition:fade={{ duration: 200 }} class="min-h-[3rem]">
      {#if profile.bio?.trim()}
        <ProfileBioMarkdown source={profile.bio} />
      {:else}
        <p class="text-text-main text-sm leading-relaxed opacity-90">{m.profile_bio_empty()}</p>
      {/if}
    </div>
  {/if}
</div>
