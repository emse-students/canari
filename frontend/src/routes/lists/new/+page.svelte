<script lang="ts">
  import { onMount } from 'svelte';
  import { createAssociation, listAssociations, type Association } from '$lib/associations/api';
  import { goto } from '$app/navigation';
  import Input from '$lib/components/ui/Input.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';

  let name = $state('');
  let slug = $state('');
  let description = $state('');
  let contactEmail = $state('');
  let promo = $state<number | ''>('');
  let parentAssociationId = $state('');
  let associations = $state<Association[]>([]);
  let submitting = $state(false);
  let error = $state('');

  onMount(async () => {
    try {
      associations = await listAssociations('association');
    } catch {
      associations = [];
    }
  });

  // Auto-generate slug from name
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
      error = 'Le nom et le slug sont requis.';
      return;
    }
    submitting = true;
    error = '';
    try {
      const list = await createAssociation({
        name: name.trim(),
        slug: slug.trim(),
        type: 'list',
        description: description.trim() || undefined,
        contactEmail: contactEmail.trim() || undefined,
        promo: promo !== '' ? Number(promo) : undefined,
        parentAssociationId: parentAssociationId || undefined,
      });
      await goto(`/lists/${list.slug}`);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Impossible de créer la liste';
    } finally {
      submitting = false;
    }
  }
</script>

<div class="px-4 py-6 sm:px-6 max-w-lg mx-auto space-y-6">
  <div>
    <a href="/lists" class="text-sm text-text-muted hover:text-text-main transition-colors">
      ← Retour aux listes
    </a>
    <h1 class="text-2xl font-extrabold text-text-main tracking-tight mt-2">Créer une liste</h1>
  </div>

  <form
    class="rounded-2xl border border-cn-border bg-white/80 p-6 space-y-5"
    onsubmit={(e) => {
      e.preventDefault();
      handleSubmit();
    }}
  >
    <Input
      label="Nom de la liste"
      bind:value={name}
      oninput={onNameInput}
      placeholder="Liste Canari 2027"
      required
    />

    <Input label="Slug (URL)" bind:value={slug} placeholder="liste-canari-2027" required />
    <p class="text-xs text-text-muted -mt-3">
      Uniquement des lettres minuscules, chiffres et tirets.
    </p>

    <Input
      label="Promotion (optionnel)"
      type="number"
      bind:value={promo}
      placeholder="2027"
    />

    <div>
      <label
        for="list-parent"
        class="block text-sm font-bold text-text-main mb-2 ml-1">Association parente (optionnel)</label
      >
      <select
        id="list-parent"
        bind:value={parentAssociationId}
        class="w-full px-4 py-3 border-2 border-cn-border rounded-2xl text-base text-text-main bg-[var(--cn-surface)] outline-none focus:border-cn-yellow"
      >
        <option value="">Aucune</option>
        {#each associations as a (a.id)}
          <option value={a.id}>{a.name}</option>
        {/each}
      </select>
    </div>

    <Textarea
      label="Description"
      bind:value={description}
      placeholder="Présentez la liste en quelques mots…"
      rows={3}
    />

    <Input
      label="E-mail de contact (optionnel)"
      type="email"
      bind:value={contactEmail}
      placeholder="contact@liste.fr"
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
      {submitting ? 'Création…' : 'Créer la liste'}
    </button>
  </form>
</div>
