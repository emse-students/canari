<script lang="ts">
  /**
   * The admin's form for a person's whole MiConnect profile (D10): campus, every cursus entry, the
   * posts and both names. It saves through `PUT /users/:id/profile`, which writes MiConnect first;
   * with a `requestId` the save is the ANSWER to that correction request.
   */
  import { Plus, Trash2, LoaderCircle } from '@lucide/svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';
  import {
    CAMPUSES,
    POSTS,
    campusLabel,
    postLabel,
    type Campus,
    type CursusEntry,
    type Post,
  } from '$lib/profile/miconnectProfile';
  import {
    FORMATIONS,
    profileErrorMessage,
    saveProfile,
    type ProfileEditInput,
  } from '$lib/profile/profileEdit';

  interface Props {
    /** The person being edited, as `GET /users/:id` serves them. */
    person: {
      id: string;
      displayName: string | null;
      firstName: string | null;
      lastName: string | null;
      campus?: Campus | null;
      cursus?: CursusEntry[];
      posts?: Post[];
    };
    /** The correction request this edit answers, when it comes from the queue. */
    requestId?: string;
    onSaved: () => void;
    onClose: () => void;
  }

  let { person, requestId, onSaved, onClose }: Props = $props();

  // The form is a COPY: nothing reaches the server until Save, and a cancelled edit leaves no trace.
  // The props are read once, on purpose - the form is mounted per edit and does not follow them.
  /* svelte-ignore state_referenced_locally */
  let campus = $state<Campus>(person.campus ?? 'saint-etienne');
  /* svelte-ignore state_referenced_locally */
  let cursus = $state<CursusEntry[]>((person.cursus ?? []).map((c) => ({ ...c })));
  /* svelte-ignore state_referenced_locally */
  let posts = $state<Post[]>([...(person.posts ?? [])]);
  /* svelte-ignore state_referenced_locally */
  let firstName = $state(person.firstName ?? '');
  /* svelte-ignore state_referenced_locally */
  let lastName = $state(person.lastName ?? '');
  let saving = $state(false);
  let error = $state('');

  const field =
    'bg-cn-surface w-full rounded-xl border border-black/10 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-500/50 dark:border-white/10';

  function addCursus() {
    cursus = [...cursus, { formation: 'ICM', promo: new Date().getFullYear() }];
  }

  function togglePost(post: Post) {
    posts = posts.includes(post) ? posts.filter((p) => p !== post) : [...posts, post];
  }

  async function save() {
    saving = true;
    error = '';
    const input: ProfileEditInput = {
      campus,
      cursus: cursus.map((c) => ({ formation: c.formation, promo: Number(c.promo) })),
      posts,
      firstName,
      lastName,
    };
    try {
      await saveProfile(person.id, input, requestId);
      onSaved();
    } catch (err) {
      Log.d('profile.edit failed', err);
      error = profileErrorMessage(err);
    } finally {
      saving = false;
    }
  }
</script>

<Modal open title={m.profile_edit_title({ name: person.displayName ?? person.id })} {onClose}>
  <form
    class="space-y-5"
    onsubmit={(e) => {
      e.preventDefault();
      void save();
    }}
  >
    <div class="grid grid-cols-2 gap-3">
      <label class="space-y-1 text-xs font-semibold">
        {m.profile_edit_first_name()}
        <input class={field} bind:value={firstName} maxlength="100" required />
      </label>
      <label class="space-y-1 text-xs font-semibold">
        {m.profile_edit_last_name()}
        <input class={field} bind:value={lastName} maxlength="100" required />
      </label>
    </div>

    <label class="block space-y-1 text-xs font-semibold">
      {m.profile_edit_campus()}
      <select class={field} bind:value={campus}>
        {#each CAMPUSES as c (c)}
          <option value={c}>{campusLabel(c)}</option>
        {/each}
      </select>
    </label>

    <fieldset class="space-y-2">
      <legend class="text-xs font-semibold">{m.profile_edit_cursus()}</legend>
      {#each cursus as entry, i (i)}
        <div class="flex items-center gap-2">
          <select
            class={field}
            bind:value={entry.formation}
            aria-label={m.profile_edit_formation()}
          >
            {#each FORMATIONS as f (f)}
              <option value={f}>{f}</option>
            {/each}
          </select>
          <input
            class="{field} w-28"
            type="number"
            min="1900"
            max="2100"
            bind:value={entry.promo}
            aria-label={m.profile_edit_promo()}
          />
          <button
            type="button"
            class="ui-icon-button text-text-muted rounded-xl hover:bg-black/5 dark:hover:bg-white/5"
            onclick={() => (cursus = cursus.filter((_, j) => j !== i))}
            title={m.profile_edit_remove_cursus()}
          >
            <Trash2 size={16} />
          </button>
        </div>
      {/each}
      <button
        type="button"
        class="text-text-muted flex items-center gap-1 text-xs font-semibold hover:underline"
        onclick={addCursus}
      >
        <Plus size={14} />
        {m.profile_edit_add_cursus()}
      </button>
    </fieldset>

    <fieldset class="space-y-2">
      <legend class="text-xs font-semibold">{m.profile_edit_posts()}</legend>
      <div class="flex flex-wrap gap-3">
        {#each POSTS as p (p)}
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={posts.includes(p)} onchange={() => togglePost(p)} />
            {postLabel(p)}
          </label>
        {/each}
      </div>
    </fieldset>

    {#if error}
      <div class="bg-red-err/10 text-red-err border-red-err/30 rounded-xl border p-3 text-sm">
        {error}
      </div>
    {/if}

    <div class="flex justify-end gap-2">
      <button
        type="button"
        class="rounded-xl px-4 py-2 text-sm font-semibold hover:bg-black/5 dark:hover:bg-white/5"
        onclick={onClose}
      >
        {m.common_cancel_button()}
      </button>
      <button
        type="submit"
        disabled={saving}
        class="bg-cn-yellow text-cn-dark flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-50"
      >
        {#if saving}<LoaderCircle size={14} class="animate-spin" />{/if}
        {requestId ? m.profile_edit_save_and_answer() : m.common_save_button()}
      </button>
    </div>
  </form>
</Modal>
