<script lang="ts">
  import { createAssociation } from '$lib/associations/api';
  import { goto } from '$app/navigation';
  import Input from '$lib/components/ui/Input.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import { ArrowLeft } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  let name = $state('');
  let slug = $state('');
  let description = $state('');
  let contactEmail = $state('');
  let submitting = $state(false);
  let error = $state('');

  function onNameInput() {
    slug = name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  async function handleSubmit() {
    if (!name.trim() || !slug.trim()) {
      error = m.assoc_new_error_required();
      return;
    }
    submitting = true;
    error = '';
    try {
      const asso = await createAssociation({
        name: name.trim(),
        slug: slug.trim(),
        description: description.trim() || undefined,
        contactEmail: contactEmail.trim() || undefined,
      });
      await goto(`/associations/${asso.slug}`);
    } catch (err) {
      error = err instanceof Error ? err.message : m.assoc_new_error_fallback();
    } finally {
      submitting = false;
    }
  }
</script>

<div class="mx-auto max-w-lg space-y-6 px-4 py-6 sm:px-6">
  <div>
    <a
      href="/associations"
      class="text-text-muted hover:text-text-main inline-flex items-center gap-2 text-sm transition-colors"
    >
      <ArrowLeft size={16} />
      {m.assoc_new_back()}
    </a>
    <h1 class="text-text-main mt-2 text-2xl font-extrabold tracking-tight">
      {m.assoc_new_heading()}
    </h1>
  </div>

  <form
    class="border-cn-border bg-cn-surface/80 space-y-5 rounded-2xl border p-6"
    onsubmit={(e) => {
      e.preventDefault();
      handleSubmit();
    }}
  >
    <Input
      label={m.assoc_new_name_label()}
      bind:value={name}
      oninput={onNameInput}
      placeholder={m.assoc_new_name_placeholder()}
      required
    />

    <Input label="Slug (URL)" bind:value={slug} placeholder="bureau-des-eleves" required />
    <p class="text-text-muted -mt-3 text-xs">
      {m.assoc_new_slug_hint()}
    </p>

    <Textarea
      label={m.assoc_new_desc_label()}
      bind:value={description}
      placeholder={m.assoc_new_desc_placeholder()}
      rows={3}
    />

    <Input
      label={m.assoc_new_email_label()}
      type="email"
      bind:value={contactEmail}
      placeholder="contact@asso.fr"
    />

    {#if error}
      <div class="border-red-err/30 bg-red-err/10 text-red-err rounded-xl border px-4 py-3 text-sm">
        {error}
      </div>
    {/if}

    <button
      type="submit"
      disabled={submitting || !name.trim() || !slug.trim()}
      class="bg-cn-yellow text-cn-dark hover:bg-cn-yellow-hover w-full rounded-xl px-5 py-2.5 text-sm font-bold shadow-sm transition-all disabled:cursor-not-allowed disabled:opacity-50"
    >
      {submitting ? m.common_creating_label() : m.assoc_new_create_btn()}
    </button>
  </form>
</div>
