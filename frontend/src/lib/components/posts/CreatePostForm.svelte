<script lang="ts">
  import { Image, ChartColumn, CalendarCheck, ClipboardList, Clock, X, CircleAlert, Building2, User, ChevronDown, Bold, Italic, Strikethrough, Heading2, Quote, Code, List, Link2 } from 'lucide-svelte';
  import { slide, fade } from 'svelte/transition';
  import { onMount, tick } from 'svelte';
  import { MediaService, compressImage } from '$lib/media';
  import { getToken } from '$lib/stores/auth';
  import { createPost, type CreatePostPayload } from '$lib/posts/api';
  import { getForms, type Form } from '$lib/forms/api';
  import {
    buildCreateFormHref,
    clearPostComposerDraft,
    emptyPostComposerDraft,
    loadPostComposerDraft,
    POST_NEW_FORM_ATTACH_KEY,
    POST_NEW_FORM_ID_KEY,
    savePostComposerDraft,
    type PostComposerDraft,
  } from '$lib/posts/postComposerDraft';
  import {
    listAssociations,
    listMyAssociations,
    listLinkableValidatedCalendarEvents,
    type Association,
    type AssociationCalendarEvent,
  } from '$lib/associations/api';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { apiFetch } from '$lib/utils/apiFetch';
  import { coreUrl } from '$lib/utils/apiUrl';
  import PollSection from './PollSection.svelte';
  import EventButtonSection from './EventButtonSection.svelte';
  import FormSection from './FormSection.svelte';
  import Button from '$lib/components/ui/Button.svelte';

  /**
   * Full-featured post creation form. Supports:
   * - Markdown text with auto-saved draft
   * - Image uploads (encrypted via MediaService)
   * - Poll, event registration button, or standalone form attachment
   * - Scheduled publication
   * - Posting as an association (admin/owner role required)
   */
  interface Props {
    /** Called after the post is successfully created so the parent can refresh its list. */
    onPostCreated: () => void;
  }

  let { onPostCreated }: Props = $props();

  // --- Text & images ---
  let markdown = $state('');
  let selectedFiles = $state<File[]>([]);
  let filePreviews = $state<string[]>([]);
  let imageCaptions = $state<string[]>([]);

  // --- Optional sections ---
  let includePoll = $state(false);
  let pollQuestion = $state('');
  let pollOptionsRaw = $state('Oui\nNon');
  let pollMultipleChoice = $state(false);

  let includeEventButton = $state(false);
  let eventLabel = $state("S'inscrire");
  let eventId = $state('');
  let eventRequiresPayment = $state(false);
  let eventAmount = $state<number>(25);
  let eventCurrency = $state('eur');
  let eventCapacity = $state<number>(100);
  let eventFormId = $state('');

  let includeForm = $state(false);
  let selectedFormId = $state('');
  let availableForms = $state<Form[]>([]);

  // --- Scheduled publication ---
  let scheduledAt = $state('');

  // --- Association identity ---
  let myAssociations = $state<Association[]>([]);
  let selectedAssociationId = $state('');
  let selectedPaymentAssociationId = $state('');
  let selectedLinkedCalendarEventId = $state('');
  let linkableCalendarEvents = $state<AssociationCalendarEvent[]>([]);
  let loadingLinkableEvents = $state(false);

  /** Associations the user may post as (admin/owner). Global admins can post as any. */
  let postAsAssociations = $derived(
    isGlobalAdmin()
      ? myAssociations
      : myAssociations.filter((a) => a.role === 'admin' || a.role === 'owner' || a.permission === 1)
  );
  /** Associations with completed Stripe onboarding (eligible for payment collection). */
  let payableAssociations = $derived(postAsAssociations.filter((a) => a.stripeOnboardingComplete));

  // --- UI state ---
  let publishing = $state(false);
  let errorMessage = $state('');
  let authToken = $state('');
  let textareaEl = $state<HTMLTextAreaElement | null>(null);

  // --- @mention autocomplete ---
  type MentionUser = { id: string; displayName: string | null };
  let mentionQuery = $state('');
  let mentionSuggestions = $state<MentionUser[]>([]);
  let mentionOpen = $state(false);
  let mentionStart = $state(-1);
  let mentionSelectedIdx = $state(-1);
  let mentionDebounce: ReturnType<typeof setTimeout> | null = null;

  async function searchMentions(query: string) {
    try {
      const res = await apiFetch(`${coreUrl()}/api/users/search?q=${encodeURIComponent(query)}`);
      if (res.ok) {
        const data: MentionUser[] = await res.json();
        mentionSuggestions = data.slice(0, 6);
        mentionOpen = mentionSuggestions.length > 0;
        mentionSelectedIdx = -1;
      }
    } catch {
      mentionSuggestions = [];
      mentionOpen = false;
    }
  }

  function handleMentionInput(e: Event) {
    const el = e.target as HTMLTextAreaElement;
    const val = el.value;
    const cursor = el.selectionStart ?? val.length;
    const textBeforeCursor = val.slice(0, cursor);
    const mentionMatch = textBeforeCursor.match(/@(\w*)$/);
    if (mentionMatch && mentionMatch[1].length > 0) {
      mentionStart = cursor - mentionMatch[0].length;
      const q = mentionMatch[1];
      mentionQuery = q;
      if (mentionDebounce) clearTimeout(mentionDebounce);
      mentionDebounce = setTimeout(() => void searchMentions(q), 250);
    } else {
      mentionOpen = false;
      mentionSuggestions = [];
      mentionQuery = '';
    }
  }

  function selectMention(user: MentionUser) {
    const displayName = user.displayName || user.id;
    const savedStart = mentionStart;
    const before = markdown.slice(0, savedStart);
    const after = markdown.slice(savedStart + 1 + mentionQuery.length);
    markdown = `${before}@${displayName} ${after}`;
    const newCursor = before.length + displayName.length + 2;
    mentionOpen = false;
    mentionSuggestions = [];
    mentionQuery = '';
    mentionStart = -1;
    void tick().then(() => {
      textareaEl?.focus();
      textareaEl?.setSelectionRange(newCursor, newCursor);
    });
  }

  function handleMentionKeydown(e: KeyboardEvent) {
    if (!mentionOpen || mentionSuggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      mentionSelectedIdx = Math.min(mentionSelectedIdx + 1, mentionSuggestions.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      mentionSelectedIdx = Math.max(mentionSelectedIdx - 1, -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (mentionSelectedIdx >= 0) selectMention(mentionSuggestions[mentionSelectedIdx]);
    } else if (e.key === 'Escape') {
      mentionOpen = false;
      mentionSuggestions = [];
    }
  }

  async function applyFormat(type: string) {
    if (!textareaEl) return;
    const selStart = textareaEl.selectionStart;
    const selEnd = textareaEl.selectionEnd;
    const selected = markdown.slice(selStart, selEnd);
    let newText = markdown;
    let newSelStart = selStart;
    let newSelEnd = selStart;

    const doWrap = (pre: string, suf: string, ph: string) => {
      const inner = selected || ph;
      newText = markdown.slice(0, selStart) + pre + inner + suf + markdown.slice(selEnd);
      newSelStart = selStart + pre.length;
      newSelEnd = newSelStart + inner.length;
    };
    const doPrefix = (pre: string, ph: string) => {
      const inner = selected || ph;
      newText = markdown.slice(0, selStart) + pre + inner + markdown.slice(selEnd);
      newSelStart = selStart + pre.length;
      newSelEnd = newSelStart + inner.length;
    };

    switch (type) {
      case 'bold': doWrap('**', '**', 'texte en gras'); break;
      case 'italic': doWrap('*', '*', 'texte en italique'); break;
      case 'strikethrough': doWrap('~~', '~~', 'texte barré'); break;
      case 'heading': doPrefix('## ', 'Titre'); break;
      case 'quote': doPrefix('> ', 'citation'); break;
      case 'code': doWrap('`', '`', 'code'); break;
      case 'list': doPrefix('- ', 'élément'); break;
      case 'link':
        if (selected) {
          newText = markdown.slice(0, selStart) + `[${selected}](url)` + markdown.slice(selEnd);
          newSelStart = selStart + selected.length + 3;
          newSelEnd = newSelStart + 3;
        } else {
          newText = markdown.slice(0, selStart) + '[texte](url)' + markdown.slice(selEnd);
          newSelStart = selStart + 1;
          newSelEnd = selStart + 6;
        }
        break;
      default: return;
    }

    markdown = newText;
    await tick();
    textareaEl.focus();
    textareaEl.setSelectionRange(newSelStart, newSelEnd);
  }

  // --- Draft auto-save (full composer state; images are not persisted) ---
  let draftRestored = $state(false);
  let draftSaved = $state(false);
  let draftSaveTimer: ReturnType<typeof setTimeout> | null = null;

  function snapshotComposerDraft(): PostComposerDraft {
    return {
      version: 1,
      markdown,
      imageCaptions: [...imageCaptions],
      includePoll,
      pollQuestion,
      pollOptionsRaw,
      pollMultipleChoice,
      includeEventButton,
      eventLabel,
      eventId,
      eventRequiresPayment,
      eventAmount,
      eventCurrency,
      eventCapacity,
      eventFormId,
      includeForm,
      selectedFormId,
      scheduledAt,
      selectedAssociationId,
      selectedPaymentAssociationId,
      selectedLinkedCalendarEventId,
    };
  }

  function applyComposerDraft(draft: PostComposerDraft) {
    markdown = draft.markdown;
    imageCaptions = draft.imageCaptions ?? [];
    includePoll = draft.includePoll;
    pollQuestion = draft.pollQuestion;
    pollOptionsRaw = draft.pollOptionsRaw;
    pollMultipleChoice = draft.pollMultipleChoice;
    includeEventButton = draft.includeEventButton;
    eventLabel = draft.eventLabel;
    eventId = draft.eventId;
    eventRequiresPayment = draft.eventRequiresPayment;
    eventAmount = draft.eventAmount;
    eventCurrency = draft.eventCurrency;
    eventCapacity = draft.eventCapacity;
    eventFormId = draft.eventFormId;
    includeForm = draft.includeForm;
    selectedFormId = draft.selectedFormId;
    scheduledAt = draft.scheduledAt;
    selectedAssociationId = draft.selectedAssociationId;
    selectedPaymentAssociationId = draft.selectedPaymentAssociationId;
    selectedLinkedCalendarEventId = draft.selectedLinkedCalendarEventId;
  }

  function persistComposerDraft() {
    savePostComposerDraft(snapshotComposerDraft());
  }

  /** Debounced draft save after any composer field changes. */
  $effect(() => {
    void snapshotComposerDraft();
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(() => {
      const snap = snapshotComposerDraft();
      if (snap.markdown.trim() || snap.includePoll || snap.includeEventButton || snap.includeForm) {
        savePostComposerDraft(snap);
        draftSaved = true;
        setTimeout(() => { draftSaved = false; }, 1800);
      } else {
        clearPostComposerDraft();
      }
    }, 800);
  });

  /** Auto-clear error banner after 5 seconds. */
  $effect(() => {
    if (errorMessage) {
      const timer = setTimeout(() => { errorMessage = ''; }, 5000);
      return () => clearTimeout(timer);
    }
  });

  /** Load validated agenda events when posting as an association. */
  $effect(() => {
    const assoId = selectedAssociationId;
    selectedLinkedCalendarEventId = '';
    linkableCalendarEvents = [];
    if (!assoId) return;
    loadingLinkableEvents = true;
    listLinkableValidatedCalendarEvents(assoId)
      .then((rows) => {
        linkableCalendarEvents = rows;
      })
      .catch((e) => {
        console.error('Failed to load linkable calendar events', e);
      })
      .finally(() => {
        loadingLinkableEvents = false;
      });
  });

  function formatLinkableEventLabel(ev: AssociationCalendarEvent): string {
    const d = new Date(ev.startsAt);
    const date = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
    const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    return `${date} ${time} — ${ev.title}`;
  }

  const mediaService = new MediaService();
  const imageInputId = 'create-post-images-input';

  onMount(async () => {
    const saved = loadPostComposerDraft();
    if (saved) {
      applyComposerDraft(saved);
      draftRestored = true;
    }

    try { authToken = await getToken(); } catch { /* retried on upload */ }
    try { availableForms = await getForms(); } catch (e) { console.error('Failed to load forms', e); }

    const newFormId = sessionStorage.getItem(POST_NEW_FORM_ID_KEY);
    const attach = sessionStorage.getItem(POST_NEW_FORM_ATTACH_KEY);
    if (newFormId) {
      sessionStorage.removeItem(POST_NEW_FORM_ID_KEY);
      sessionStorage.removeItem(POST_NEW_FORM_ATTACH_KEY);
      try {
        availableForms = await getForms();
      } catch {
        /* keep previous list */
      }
      if (attach === 'event') {
        includeEventButton = true;
        includeForm = false;
        eventFormId = newFormId;
      } else {
        includeForm = true;
        includeEventButton = false;
        selectedFormId = newFormId;
      }
    }

    try {
      myAssociations = isGlobalAdmin() ? await listAssociations() : await listMyAssociations();
    } catch (e) { console.error('Failed to load associations', e); }
  });

  /** Replace the current image selection with a new set of files. Revokes stale object URLs. */
  function onPickFiles(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []).filter((f) => f.type.startsWith('image/'));
    filePreviews.forEach((url) => URL.revokeObjectURL(url));
    selectedFiles = files;
    filePreviews = files.map((f) => URL.createObjectURL(f));
    imageCaptions = files.map(() => '');
  }

  /** Remove a single image from the selection by index. */
  function removeFile(i: number) {
    URL.revokeObjectURL(filePreviews[i]);
    selectedFiles = selectedFiles.filter((_, idx) => idx !== i);
    filePreviews = filePreviews.filter((_, idx) => idx !== i);
    imageCaptions = imageCaptions.filter((_, idx) => idx !== i);
  }

  /** Upload images, assemble the payload, call createPost, then reset the form. */
  async function publishPost() {
    publishing = true;
    errorMessage = '';
    try {
      if (!markdown.trim() && selectedFiles.length === 0) {
        throw new Error('Le contenu du post ou une image est requis.');
      }
      if (selectedFiles.length > 0 && !authToken) {
        try { authToken = await getToken(); }
        catch { throw new Error("Impossible d'obtenir un jeton pour l'envoi d'images."); }
      }

      // Compress then encrypt-upload each image; collect the resulting refs.
      const images = [];
      for (let i = 0; i < selectedFiles.length; i++) {
        const compressed = await compressImage(selectedFiles[i], 1440, 1440, 0.82);
        const ref = await mediaService.encryptAndUpload(compressed, authToken);
        const caption = imageCaptions[i]?.trim();
        images.push({ ...ref, ...(caption ? { caption } : {}) });
      }

      const payload: CreatePostPayload = {
        markdown,
        images,
        ...(scheduledAt ? { scheduledAt: new Date(scheduledAt).toISOString() } : {}),
      };

      if (includePoll) {
        const options = pollOptionsRaw.split('\n').map((l) => l.trim()).filter(Boolean).map((label) => ({ label }));
        if (!pollQuestion.trim() || options.length < 2) {
          throw new Error('Un sondage nécessite une question et au moins deux options.');
        }
        payload.polls = [{ question: pollQuestion.trim(), options, multipleChoice: pollMultipleChoice }];
      }

      if (includeEventButton) {
        if (!eventLabel.trim() || !eventId.trim()) {
          throw new Error("Le libellé et l'identifiant de l'événement sont requis.");
        }
        payload.eventButtons = [{
          label: eventLabel.trim(),
          eventId: eventId.trim(),
          requiresPayment: eventRequiresPayment,
          amountCents: eventRequiresPayment ? Math.round(Number(eventAmount) * 100) : undefined,
          currency: eventRequiresPayment ? eventCurrency.toLowerCase() : undefined,
          capacity: Number(eventCapacity),
          formId: eventFormId || undefined,
        }];
      }

      if (includeForm && !includeEventButton) {
        if (!selectedFormId) throw new Error('Veuillez sélectionner un formulaire.');
        payload.attachedFormId = selectedFormId;
      }

      if (selectedAssociationId) payload.associationId = selectedAssociationId;
      if (selectedLinkedCalendarEventId.trim()) {
        payload.linkedCalendarEventId = selectedLinkedCalendarEventId.trim();
      }
      if (selectedPaymentAssociationId) payload.paymentAssociationId = selectedPaymentAssociationId;

      await createPost(payload);

      // Reset all state after successful creation
      clearPostComposerDraft();
      draftRestored = false;
      markdown = '';
      filePreviews.forEach((url) => URL.revokeObjectURL(url));
      selectedFiles = []; filePreviews = []; imageCaptions = [];
      includePoll = false; pollQuestion = ''; pollOptionsRaw = 'Oui\nNon';
      includeEventButton = false;
      includeForm = false;
      scheduledAt = '';
      selectedAssociationId = '';
      selectedPaymentAssociationId = '';
      selectedLinkedCalendarEventId = '';
      onPostCreated();
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'Impossible de publier le post';
    } finally {
      publishing = false;
    }
  }
</script>

<article
  class="relative mb-6 overflow-hidden rounded-[2rem] border border-black/5 dark:border-white/10 bg-white/70 dark:bg-[#151B2C]/70 shadow-sm backdrop-blur-2xl transition-all duration-300 focus-within:shadow-lg focus-within:border-amber-500/30"
>
  <!-- En-tête du Formulaire -->
  <div class="border-b border-black/5 dark:border-white/10 bg-white/40 dark:bg-black/20 px-5 py-4">
    <p class="text-[0.65rem] font-extrabold uppercase tracking-widest text-amber-500 mb-0.5">Créer une publication</p>
    <p class="text-sm font-semibold text-text-main opacity-90">
      Partagez une annonce, un événement ou un sondage avec le réseau.
    </p>
  </div>

  <div class="p-4 sm:p-5">

    <!-- Sélecteurs d'Association (Affichés uniquement si l'utilisateur gère une asso) -->
    {#if postAsAssociations.length > 0}
      <div class="mb-5 grid gap-4 sm:grid-cols-2">
        <!-- Publier en tant que -->
        <div>
          <label
            for="post-association-select"
            class="mb-1.5 flex items-center gap-1.5 text-[0.65rem] font-extrabold uppercase tracking-wider text-text-muted ml-1"
          >
            Publier en tant que
          </label>
          <div class="relative group">
            <span class="pointer-events-none absolute left-3.5 top-1/2 z-[1] -translate-y-1/2 text-text-muted group-focus-within:text-amber-500 transition-colors" aria-hidden="true">
              {#if selectedAssociationId}<Building2 size={16} strokeWidth={2.5} />{:else}<User size={16} strokeWidth={2.5} />{/if}
            </span>
            <select
              id="post-association-select"
              bind:value={selectedAssociationId}
              class="w-full appearance-none rounded-xl border border-black/5 dark:border-white/10 bg-black/5 dark:bg-white/5 pl-10 pr-10 py-3 text-sm font-bold text-text-main shadow-inner transition-all outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 hover:bg-black/10 dark:hover:bg-white/10 cursor-pointer"
            >
              <option value="" class="bg-white dark:bg-zinc-900 font-medium">Profil personnel</option>
              {#each postAsAssociations as a (a.id)}
                <option value={a.id} class="bg-white dark:bg-zinc-900 font-medium">{a.name}</option>
              {/each}
            </select>
            <div class="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-text-muted group-focus-within:text-amber-500 transition-colors">
              <ChevronDown size={16} strokeWidth={2.5} />
            </div>
          </div>
        </div>

        <!-- Encaissement Stripe (Affiché uniquement si une asso est sélectionnée) -->
        {#if payableAssociations.length > 0 && selectedAssociationId}
          <div transition:fade={{ duration: 200 }}>
            <label
              for="post-payment-association-select"
              class="mb-1.5 flex items-center gap-1.5 text-[0.65rem] font-extrabold uppercase tracking-wider text-text-muted ml-1"
            >
              Encaissement (Stripe)
            </label>
            <div class="relative group">
              <span class="pointer-events-none absolute left-3.5 top-1/2 z-[1] -translate-y-1/2 text-amber-500" aria-hidden="true">
                <Building2 size={16} strokeWidth={2.5} />
              </span>
              <select
                id="post-payment-association-select"
                bind:value={selectedPaymentAssociationId}
                class="w-full appearance-none rounded-xl border border-black/5 dark:border-white/10 bg-black/5 dark:bg-white/5 pl-10 pr-10 py-3 text-sm font-bold text-text-main shadow-inner transition-all outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 hover:bg-black/10 dark:hover:bg-white/10 cursor-pointer"
              >
                <option value="" class="bg-white dark:bg-zinc-900 font-medium">Aucun compte lié</option>
                {#each payableAssociations as a (a.id)}
                  <option value={a.id} class="bg-white dark:bg-zinc-900 font-medium">{a.name}</option>
                {/each}
              </select>
              <div class="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-text-muted group-focus-within:text-amber-500 transition-colors">
                <ChevronDown size={16} strokeWidth={2.5} />
              </div>
            </div>
          </div>
        {/if}

        {#if selectedAssociationId}
          <div class="sm:col-span-2" transition:fade={{ duration: 200 }}>
            <label
              for="post-linked-calendar-event"
              class="mb-1.5 flex items-center gap-1.5 text-[0.65rem] font-extrabold uppercase tracking-wider text-text-muted ml-1"
            >
              <CalendarCheck size={14} strokeWidth={2.5} class="text-amber-500" />
              Lier à un événement validé (optionnel)
            </label>
            <select
              id="post-linked-calendar-event"
              bind:value={selectedLinkedCalendarEventId}
              disabled={loadingLinkableEvents}
              class="w-full appearance-none rounded-xl border border-black/5 dark:border-white/10 bg-black/5 dark:bg-white/5 px-4 py-3 text-sm font-bold text-text-main shadow-inner transition-all outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 hover:bg-black/10 dark:hover:bg-white/10 cursor-pointer disabled:opacity-60"
            >
              <option value="" class="bg-white dark:bg-zinc-900 font-medium">
                {loadingLinkableEvents ? 'Chargement…' : '— Aucun événement —'}
              </option>
              {#each linkableCalendarEvents as ev (ev.id)}
                <option value={ev.id} class="bg-white dark:bg-zinc-900 font-medium">
                  {formatLinkableEventLabel(ev)}
                </option>
              {/each}
            </select>
            <p class="mt-1.5 text-[0.7rem] text-text-muted ml-1">
              Seuls les événements validés de l’agenda apparaissent ici.
            </p>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Bannière Brouillon Restauré -->
    {#if draftRestored}
      <div
        class="mb-3 flex items-center justify-between rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 shadow-sm"
        transition:slide={{ duration: 200 }}
      >
        <span class="text-[0.75rem] font-bold text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
          Brouillon restauré
          <span class="font-medium text-amber-700/70 dark:text-amber-400/70">(texte et options ; pas les photos)</span>
        </span>
        <button
          type="button"
          onclick={() => {
            applyComposerDraft(emptyPostComposerDraft());
            clearPostComposerDraft();
            draftRestored = false;
          }}
          class="text-xs font-bold text-amber-700/60 dark:text-amber-400/60 hover:text-amber-700 dark:hover:text-amber-400 transition-colors outline-none focus-visible:underline"
        >
          Effacer
        </button>
      </div>
    {/if}

    <!-- Zone de Texte & Aperçu Médias (Inner Shadow Container) -->
    <div class="relative rounded-[1.5rem] border border-black/5 dark:border-white/10 bg-black/5 dark:bg-black/40 shadow-inner p-2 mb-2 transition-colors focus-within:bg-white/50 dark:focus-within:bg-black/60">

      <!-- Feedback de Sauvegarde auto -->
      {#if draftSaved}
        <span
          class="pointer-events-none absolute right-4 top-3 text-[0.65rem] font-bold uppercase tracking-wider text-text-muted opacity-60"
          transition:fade={{ duration: 200 }}
        >
          Sauvegardé
        </span>
      {/if}

      <!-- Barre d'outils Markdown -->
      <div class="flex items-center gap-0.5 px-2 pt-1.5 pb-1.5 flex-wrap border-b border-black/5 dark:border-white/5 mb-1">
        <button type="button" title="Gras" onclick={() => applyFormat('bold')} class="p-1.5 rounded-lg text-text-muted hover:bg-black/10 dark:hover:bg-white/10 hover:text-text-main transition-colors outline-none focus-visible:ring-1 focus-visible:ring-amber-500"><Bold size={15} strokeWidth={2} /></button>
        <button type="button" title="Italique" onclick={() => applyFormat('italic')} class="p-1.5 rounded-lg text-text-muted hover:bg-black/10 dark:hover:bg-white/10 hover:text-text-main transition-colors outline-none focus-visible:ring-1 focus-visible:ring-amber-500"><Italic size={15} strokeWidth={2} /></button>
        <button type="button" title="Barré" onclick={() => applyFormat('strikethrough')} class="p-1.5 rounded-lg text-text-muted hover:bg-black/10 dark:hover:bg-white/10 hover:text-text-main transition-colors outline-none focus-visible:ring-1 focus-visible:ring-amber-500"><Strikethrough size={15} strokeWidth={2} /></button>
        <div class="h-4 w-px bg-black/10 dark:bg-white/10 mx-1 shrink-0"></div>
        <button type="button" title="Titre" onclick={() => applyFormat('heading')} class="p-1.5 rounded-lg text-text-muted hover:bg-black/10 dark:hover:bg-white/10 hover:text-text-main transition-colors outline-none focus-visible:ring-1 focus-visible:ring-amber-500"><Heading2 size={15} strokeWidth={2} /></button>
        <button type="button" title="Citation" onclick={() => applyFormat('quote')} class="p-1.5 rounded-lg text-text-muted hover:bg-black/10 dark:hover:bg-white/10 hover:text-text-main transition-colors outline-none focus-visible:ring-1 focus-visible:ring-amber-500"><Quote size={15} strokeWidth={2} /></button>
        <button type="button" title="Code" onclick={() => applyFormat('code')} class="p-1.5 rounded-lg text-text-muted hover:bg-black/10 dark:hover:bg-white/10 hover:text-text-main transition-colors outline-none focus-visible:ring-1 focus-visible:ring-amber-500"><Code size={15} strokeWidth={2} /></button>
        <div class="h-4 w-px bg-black/10 dark:bg-white/10 mx-1 shrink-0"></div>
        <button type="button" title="Liste" onclick={() => applyFormat('list')} class="p-1.5 rounded-lg text-text-muted hover:bg-black/10 dark:hover:bg-white/10 hover:text-text-main transition-colors outline-none focus-visible:ring-1 focus-visible:ring-amber-500"><List size={15} strokeWidth={2} /></button>
        <button type="button" title="Lien" onclick={() => applyFormat('link')} class="p-1.5 rounded-lg text-text-muted hover:bg-black/10 dark:hover:bg-white/10 hover:text-text-main transition-colors outline-none focus-visible:ring-1 focus-visible:ring-amber-500"><Link2 size={15} strokeWidth={2} /></button>
      </div>

      <div class="relative">
        {#if mentionOpen && mentionSuggestions.length > 0}
          <ul
            class="absolute bottom-full mb-1 left-4 right-4 z-50 bg-white/95 dark:bg-gray-900/95 border border-black/10 dark:border-white/10 rounded-xl shadow-xl max-h-48 overflow-auto backdrop-blur-sm"
          >
            {#each mentionSuggestions as user, i (user.id)}
              <li>
                <button
                  type="button"
                  class="w-full px-4 py-2 text-left text-sm transition-colors first:rounded-t-xl last:rounded-b-xl {i === mentionSelectedIdx ? 'bg-amber-100/60 dark:bg-amber-900/30' : 'hover:bg-amber-50 dark:hover:bg-amber-900/20'}"
                  onmousedown={() => selectMention(user)}
                >
                  <span class="font-bold text-amber-600 dark:text-amber-400 mr-0.5">@</span><span class="font-medium text-text-main">{user.displayName || user.id}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
        <textarea
          bind:this={textareaEl}
          bind:value={markdown}
          oninput={handleMentionInput}
          onkeydown={handleMentionKeydown}
          placeholder="Écrivez votre message ici..."
          rows={5}
          class="custom-scrollbar min-h-[120px] w-full resize-none rounded-xl bg-transparent px-4 py-3.5 text-[0.95rem] sm:text-[1rem] font-medium leading-relaxed text-text-main placeholder:text-text-muted/60 outline-none"
        ></textarea>
      </div>

      <!-- Aperçu des images & Légendes -->
      {#if filePreviews.length > 0}
        <div
          class="flex snap-x snap-mandatory gap-2.5 overflow-x-auto px-3 pb-3 pt-2 custom-scrollbar"
          transition:slide={{ duration: 200 }}
          role="list"
        >
          {#each filePreviews as src, i (src)}
            <div class="flex w-[100px] shrink-0 snap-start flex-col gap-2 sm:w-[120px]" role="listitem">
              <!-- Miniature -->
              <div class="relative aspect-square w-full overflow-hidden rounded-2xl border border-black/10 dark:border-white/10 shadow-sm group">
                <img {src} alt="Aperçu" class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" />
                <button
                  type="button"
                  onclick={() => removeFile(i)}
                  class="absolute right-1.5 top-1.5 rounded-full bg-black/60 p-1.5 text-white shadow-sm backdrop-blur-md transition-all hover:bg-red-500 hover:scale-110 active:scale-95 outline-none focus-visible:ring-2 focus-visible:ring-red-400 opacity-0 group-hover:opacity-100 focus:opacity-100"
                  aria-label="Retirer cette image"
                  title="Supprimer"
                >
                  <X size={14} strokeWidth={2.5} />
                </button>
              </div>
              <!-- Input Légende -->
              <input
                type="text"
                bind:value={imageCaptions[i]}
                placeholder="Légende (opt.)"
                maxlength="120"
                class="w-full rounded-lg border border-black/10 dark:border-white/10 bg-white/70 dark:bg-black/40 px-2.5 py-1.5 text-[0.7rem] font-semibold text-text-main placeholder:text-text-muted/60 outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500/30 transition-all shadow-inner"
              />
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <!-- Sections Optionnelles & Footer -->
  <div class="space-y-4 border-t border-black/5 dark:border-white/10 px-4 pb-5 pt-5 sm:px-5">

    <!-- Sondage -->
    {#if includePoll}
      <div transition:slide={{ duration: 300, easing: (t) => t * (2 - t) }}>
        <PollSection
          bind:question={pollQuestion}
          bind:optionsRaw={pollOptionsRaw}
          bind:multipleChoice={pollMultipleChoice}
          onRemove={() => (includePoll = false)}
        />
      </div>
    {/if}

    <!-- Événement -->
    {#if includeEventButton}
      <div transition:slide={{ duration: 300, easing: (t) => t * (2 - t) }}>
        <EventButtonSection
          bind:label={eventLabel}
          bind:eventId={eventId}
          bind:requiresPayment={eventRequiresPayment}
          bind:amount={eventAmount}
          bind:currency={eventCurrency}
          bind:capacity={eventCapacity}
          bind:formId={eventFormId}
          {availableForms}
          createFormHref={buildCreateFormHref('event')}
          onBeforeCreateForm={persistComposerDraft}
          onRemove={() => (includeEventButton = false)}
        />
      </div>
    {/if}

    <!-- Formulaire (Exclusif avec l'Événement) -->
    {#if includeForm && !includeEventButton}
      <div transition:slide={{ duration: 300, easing: (t) => t * (2 - t) }}>
        <FormSection
          bind:selectedFormId
          {availableForms}
          createFormHref={buildCreateFormHref('form')}
          onBeforeCreateForm={persistComposerDraft}
          onRemove={() => (includeForm = false)}
        />
      </div>
    {/if}

    <!-- Bannière d'Erreur -->
    {#if errorMessage}
      <div
        transition:slide={{ duration: 200 }}
        class="flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-red-600 dark:text-red-400 shadow-inner"
      >
        <CircleAlert size={18} strokeWidth={2.5} class="mt-0.5 shrink-0" />
        <span class="text-sm font-bold leading-snug">{errorMessage}</span>
      </div>
    {/if}

    <!-- Barre d'outils (Toggles) + Bouton Publier -->
    <div class="flex flex-col-reverse gap-4 pt-1 sm:flex-row sm:items-center sm:justify-between">

      <!-- Boutons d'ajouts (Toolbar) -->
      <div class="custom-scrollbar flex flex-wrap items-center gap-2 overflow-x-auto rounded-[1.25rem] bg-white/50 dark:bg-black/20 p-1.5 shadow-inner border border-black/5 dark:border-white/5 w-full sm:w-auto">

        <!-- Ajouter des photos -->
        <label
          for={imageInputId}
          title="Photos"
          class="flex cursor-pointer items-center gap-2 rounded-xl px-3 py-2 text-text-muted transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 shrink-0
          {selectedFiles.length > 0 ? 'bg-amber-500/15 font-bold text-amber-600 dark:text-amber-400 shadow-sm' : 'hover:bg-black/5 dark:hover:bg-white/10 hover:text-text-main'}"
        >
          <Image size={18} strokeWidth={selectedFiles.length > 0 ? 2.5 : 2} />
          <span class="hidden text-xs sm:inline">Photos</span>
        </label>
        <input id={imageInputId} type="file" accept="image/*" multiple onchange={onPickFiles} class="sr-only" />

        <!-- Ajouter un sondage -->
        <button
          type="button" title="Sondage"
          onclick={() => (includePoll = !includePoll)}
          class="flex items-center gap-2 rounded-xl px-3 py-2 text-text-muted transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 shrink-0
          {includePoll ? 'bg-amber-500/15 font-bold text-amber-600 dark:text-amber-400 shadow-sm' : 'hover:bg-black/5 dark:hover:bg-white/10 hover:text-text-main'}"
        >
          <ChartColumn size={18} strokeWidth={includePoll ? 2.5 : 2} />
          <span class="hidden text-xs sm:inline">Sondage</span>
        </button>

        <!-- Ajouter un événement -->
        <button
          type="button" title="Événement"
          onclick={() => { includeEventButton = !includeEventButton; if (includeEventButton) includeForm = false; }}
          class="flex items-center gap-2 rounded-xl px-3 py-2 text-text-muted transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 shrink-0
          {includeEventButton ? 'bg-amber-500/15 font-bold text-amber-600 dark:text-amber-400 shadow-sm' : 'hover:bg-black/5 dark:hover:bg-white/10 hover:text-text-main'}"
        >
          <CalendarCheck size={18} strokeWidth={includeEventButton ? 2.5 : 2} />
          <span class="hidden text-xs sm:inline">Événement</span>
        </button>

        <!-- Ajouter un formulaire (si pas d'événement) -->
        {#if !includeEventButton}
          <button
            type="button" title="Formulaire"
            onclick={() => (includeForm = !includeForm)}
            class="flex items-center gap-2 rounded-xl px-3 py-2 text-text-muted transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 shrink-0
            {includeForm ? 'bg-amber-500/15 font-bold text-amber-600 dark:text-amber-400 shadow-sm' : 'hover:bg-black/5 dark:hover:bg-white/10 hover:text-text-main'}"
          >
            <ClipboardList size={18} strokeWidth={includeForm ? 2.5 : 2} />
            <span class="hidden text-xs sm:inline">Formulaire</span>
          </button>
        {/if}

        <!-- Séparateur vertical visuel -->
        <div class="h-6 w-px bg-black/10 dark:bg-white/10 mx-0.5 shrink-0 hidden sm:block"></div>

        <!-- Programmation (Date Picker intégré) -->
        <div class="relative flex items-center bg-black/5 dark:bg-white/5 rounded-xl px-2 py-1.5 focus-within:ring-2 focus-within:ring-amber-500/50 transition-all shrink-0 {scheduledAt ? 'bg-amber-500/10 border border-amber-500/20' : ''}">
          <Clock size={16} strokeWidth={2.5} class="ml-1 text-text-muted {scheduledAt ? 'text-amber-600 dark:text-amber-400' : ''}" />
          <input
            type="datetime-local"
            bind:value={scheduledAt}
            min={new Date(Date.now() + 60000).toISOString().slice(0, 16)}
            title="Programmer la publication"
            class="bg-transparent pl-2 pr-1 text-[0.7rem] font-bold text-text-main outline-none cursor-pointer {scheduledAt ? 'w-36 text-amber-700 dark:text-amber-400' : 'w-5 sm:w-28 text-transparent sm:text-text-main'} transition-all"
          />
          {#if scheduledAt}
            <button
              type="button"
              onclick={() => (scheduledAt = '')}
              class="rounded-full p-1 text-text-muted transition-colors hover:text-red-500 hover:bg-red-500/10 outline-none"
              title="Annuler la programmation"
            >
              <X size={14} strokeWidth={2.5} />
            </button>
          {/if}
        </div>
      </div>

      <!-- Bouton Publier / Programmer -->
      <Button
        type="button"
        class="min-w-[10rem] shrink-0 px-8 py-3 text-sm !font-extrabold sm:w-auto shadow-md shadow-amber-500/20 active:translate-y-0"
        disabled={publishing || (!markdown.trim() && selectedFiles.length === 0)}
        loading={publishing}
        onclick={publishPost}
      >
        {#if publishing}
          {scheduledAt ? 'Programmation…' : 'Publication…'}
        {:else}
          {scheduledAt ? 'Programmer' : 'Publier'}
        {/if}
      </Button>
    </div>
  </div>
</article>

<style>
  .custom-scrollbar::-webkit-scrollbar { width: 4px; height: 4px; }
  .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
  .custom-scrollbar::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--cn-surface) 20%, transparent);
    border-radius: 4px;
  }
  :global([data-theme='dark']) .custom-scrollbar::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.15);
  }

  /* Pour cacher la petite icône calendrier native sur Webkit et avoir juste l'icône personnalisée Lucide */
  input[type="datetime-local"]::-webkit-calendar-picker-indicator {
    cursor: pointer;
    opacity: 0;
    position: absolute;
    left: 0;
    width: 100%;
    height: 100%;
  }
</style>
