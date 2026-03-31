<script lang="ts">
  import { createAssociation } from '$lib/associations/api';
  import { goto } from '$app/navigation';
  import Input from '$lib/components/ui/Input.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';

  let name = $state('');
  let slug = $state('');
  let description = $state('');
  let submitting = $state(false);
  let error = $state('');

  // Auto-generate slug from name
  function onNameInput() {
    slug = name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  async function handleSubmit() {
    if (!name.trim() || !slug.trim()) {
      error = 'Le nom et le slug sont requis.';
      return;
    }
    submitting = true;
    error = '';
    try {
      const asso = await createAssociation({
        name: name.trim(),
        slug: slug.trim(),
        description: description.trim() || undefined,
      });
      await goto(`/associations/${asso.slug}`);
    } catch (err) {
      error = err instanceof Error ? err.message : "Impossible de créer l'association";
    } finally {
      submitting = false;
    }
  }
</script>

<div class="px-4 py-6 sm:px-6 max-w-lg mx-auto space-y-6">
  <div>
    <a href="/associations" class="text-sm text-text-muted hover:text-text-main transition-colors">
      ← Retour aux associations
    </a>
    <h1 class="text-2xl font-extrabold text-text-main tracking-tight mt-2">
      Créer une association
    </h1>
  </div>

  <form
    class="rounded-2xl border border-cn-border bg-white/80 p-6 space-y-5"
    onsubmit={(e) => {
      e.preventDefault();
      handleSubmit();
    }}
  >
    <Input
      label="Nom de l'association"
      bind:value={name}
      oninput={onNameInput}
      placeholder="Bureau des Élèves"
      required
    />

    <Input label="Slug (URL)" bind:value={slug} placeholder="bureau-des-eleves" required />
    <p class="text-xs text-text-muted -mt-3">
      Uniquement des lettres minuscules, chiffres et tirets.
    </p>

    <Textarea
      label="Description"
      bind:value={description}
      placeholder="Décrivez l'association en quelques mots…"
      rows={3}
    />

    {#if error}
      <div class="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
        {error}
      </div>
    {/if}

    <button
      type="submit"
      disabled={submitting || !name.trim() || !slug.trim()}
      class="w-full rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-dark shadow-sm transition-all hover:bg-cn-yellow-hover disabled:cursor-not-allowed disabled:opacity-50"
    >
      {submitting ? 'Création…' : "Créer l'association"}
    </button>
  </form>
</div>
