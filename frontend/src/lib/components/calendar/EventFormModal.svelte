<script lang="ts">
  import { X, ImagePlus, Link2 } from '@lucide/svelte';
  import { portal } from '$lib/actions/portal';
  import Input from '$lib/components/ui/Input.svelte';
  import MarkdownComposerField from '$lib/components/shared/MarkdownComposerField.svelte';
  import CoOwnerPicker from '$lib/components/calendar/CoOwnerPicker.svelte';
  import AssociationOptions from '$lib/components/associations/AssociationOptions.svelte';
  import { calendarErrorMessage } from '$lib/calendar/calendarErrors';
  import {
    validateEventForm,
    type EventFormCapabilities,
    type EventFormValues,
  } from '$lib/calendar/eventForm';
  import type { Association } from '$lib/associations/api';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE EVENT FORM, ONCE, FOR EVERY SURFACE THAT OFFERS ONE.
   *
   * There were four modals and two implementations: "Proposer un evenement" and "Modifier
   * l'evenement" on an association's page, "Deposer un evenement" and "Modifier l'evenement" on the
   * global agenda - 840 and 732 lines carrying the same six fields declared twice, and neither able
   * to do what the other could. The association's pair could not file under another association;
   * the agenda's pair could not set the kind, attach a poster or link a form.
   *
   * **What differed was never the form - it was which fields each surface may DECIDE.** That is a
   * capability, so it is a prop; and the three names are one more, since "Proposer", "Deposer" and
   * "Modifier" are the same form under three headings.
   *
   * The component owns the form: its state, its validation, its error line, and the mapping of a
   * refusal to a sentence. The CALLER owns the endpoint, because that is the one thing the two
   * surfaces genuinely disagree about - the agenda posts through the caller's own BDE association
   * with `targetAssocId`, the association page posts on itself.
   */
  interface PosterControls {
    url: string | null;
    uploading: boolean;
    onUpload: (file: File) => Promise<void>;
    onRemove: () => Promise<void>;
  }

  interface Props {
    open: boolean;
    /** The heading, and with it the modal's name. */
    heading: string;
    /** A line under the heading - the pending-validation note, or who owns the event being edited. */
    note?: string | null;
    /** An edit reaches endpoints a creation cannot, and the poster is one of them. */
    editing?: boolean;
    values: EventFormValues;
    capabilities?: EventFormCapabilities;
    /** Offered only when `capabilities.canTargetAnotherAssociation`. */
    associations?: Association[];
    /** Forms this association may link. `null` hides the section entirely. */
    linkableForms?: { id: string; title: string }[] | null;
    /** Omitted by a surface with no upload endpoint for this event. */
    poster?: PosterControls | null;
    submitLabel: string;
    savingLabel: string;
    onSubmit: (values: EventFormValues) => Promise<void>;
    onClose: () => void;
  }

  let {
    open,
    heading,
    note = null,
    editing = false,
    values = $bindable(),
    capabilities = {},
    associations = [],
    linkableForms = null,
    poster = null,
    submitLabel,
    savingLabel,
    onSubmit,
    onClose,
  }: Props = $props();

  let saving = $state(false);
  let error = $state('');

  /** Clears the refusal left by the previous attempt whenever the modal is reopened. */
  $effect(() => {
    if (open) error = '';
  });

  async function submit() {
    const verdict = validateEventForm(values, capabilities);
    if (!verdict.ok) {
      error = verdict.message();
      return;
    }
    saving = true;
    error = '';
    try {
      await onSubmit(values);
    } catch (e) {
      // The three date refusals arrive as CODES, so the reader is told which rule they broke rather
      // than shown the server's English or a flat "something went wrong". One mapper, both surfaces.
      error = calendarErrorMessage(e, m.common_save_error);
    } finally {
      saving = false;
    }
  }

  // The poster's two endpoints write to the SAME error line as the save, so they are caught here
  // rather than by the caller. An owner of the line is an owner of everything that can fill it.
  async function onPosterPicked(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !poster) return;
    try {
      await poster.onUpload(file);
    } catch {
      error = m.asso_calendar_image_upload_error();
    } finally {
      input.value = '';
    }
  }

  async function onPosterRemoved() {
    if (!poster) return;
    try {
      await poster.onRemove();
    } catch {
      error = m.common_delete_error();
    }
  }
</script>

{#if open}
  <div use:portal>
    <div
      data-keyboard-aware-overlay
      class="z-(--z-modal) flex items-end justify-center bg-black/40 sm:items-center"
      role="presentation"
      onclick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        class="keyboard-aware-modal-panel border-cn-border max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-t-3xl border bg-(--cn-surface) p-6 shadow-xl sm:rounded-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="event-form-title"
      >
        <h3 id="event-form-title" class="text-text-main text-lg font-bold">{heading}</h3>
        {#if note}
          <p class="text-text-muted text-xs">{note}</p>
        {/if}

        {#if capabilities.canTargetAnotherAssociation && !editing}
          <div>
            <label class="text-text-main mb-1 ml-1 block text-sm font-bold" for="event-form-asso"
              >{m.calendar_deposit_on_behalf()}</label
            >
            <select
              id="event-form-asso"
              bind:value={values.targetAssociationId}
              class="border-cn-border text-text-main w-full rounded-xl border bg-(--cn-surface) px-3 py-2 text-sm"
            >
              <AssociationOptions {associations} />
            </select>
          </div>
        {/if}

        <Input label={m.asso_calendar_event_title_label()} bind:value={values.title} />

        <!--
          Entry kind: a normal event card vs a full-day background band (break / vacation). Offered
          only to a viewer the server would accept (`assertMayDecideKind`) - and for everybody else
          the field is not merely hidden but UNSENT, so editing a band someone else declared leaves
          it a band instead of being refused for resending a kind they may not decide.
        -->
        {#if capabilities.canSetKind}
          <div>
            <span class="text-text-main mb-1 ml-1 block text-sm font-bold"
              >{m.asso_calendar_event_kind_label()}</span
            >
            <div class="grid grid-cols-2 gap-2">
              <button
                type="button"
                onclick={() => (values.kind = 'event')}
                class="rounded-xl border px-3 py-2 text-sm font-semibold transition-colors {values.kind ===
                'event'
                  ? 'border-cn-yellow bg-cn-yellow/10 text-cn-dark'
                  : 'border-cn-border text-text-muted hover:bg-cn-bg'}"
              >
                {m.asso_calendar_event_kind_event()}
              </button>
              <button
                type="button"
                onclick={() => (values.kind = 'break')}
                class="rounded-xl border px-3 py-2 text-sm font-semibold transition-colors {values.kind ===
                'break'
                  ? 'border-cn-yellow bg-cn-yellow/10 text-cn-dark'
                  : 'border-cn-border text-text-muted hover:bg-cn-bg'}"
              >
                {m.asso_calendar_event_kind_break()}
              </button>
            </div>
            {#if values.kind === 'break'}
              <p class="text-text-muted mt-1 ml-1 text-xs">
                {m.asso_calendar_event_kind_break_hint()}
              </p>
            {/if}
          </div>
        {/if}

        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label class="text-text-main mb-1 ml-1 block text-sm font-bold" for="event-form-start"
              >{m.asso_calendar_event_start_label()}</label
            >
            <input
              id="event-form-start"
              type="datetime-local"
              bind:value={values.start}
              class="border-cn-border text-text-main w-full rounded-xl border bg-(--cn-surface) px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label class="text-text-main mb-1 ml-1 block text-sm font-bold" for="event-form-end"
              >{m.asso_calendar_event_end_label()}</label
            >
            <input
              id="event-form-end"
              type="datetime-local"
              bind:value={values.end}
              class="border-cn-border text-text-main w-full rounded-xl border bg-(--cn-surface) px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div>
          <p class="text-text-main mb-1 ml-1 block text-sm font-bold">
            {m.asso_calendar_event_description_label()}
          </p>
          <MarkdownComposerField
            bind:value={values.description}
            placeholder={m.calendar_deposit_placeholder()}
            minHeight="100px"
          />
        </div>

        <!--
          The poster needs an event id, because the upload endpoint addresses an existing row. That
          restriction is a consequence of the endpoint rather than a policy, and it lives HERE now
          rather than being re-derived by every surface that draws this form.
        -->
        {#if poster}
          {#if editing}
            <div class="space-y-2">
              <p class="text-text-main ml-1 text-sm font-bold">
                {m.asso_calendar_event_poster_label()}
              </p>
              {#if poster.url}
                <div class="border-cn-border relative overflow-hidden rounded-xl border">
                  <img
                    src={poster.url}
                    alt={m.asso_calendar_poster_alt()}
                    class="max-h-48 w-full object-cover"
                    loading="lazy"
                  />
                  <button
                    type="button"
                    onclick={onPosterRemoved}
                    disabled={poster.uploading}
                    class="ui-icon-button absolute top-2 right-2 rounded-full bg-black/60 text-white hover:bg-black/80"
                    title={m.asso_calendar_poster_remove_title()}
                  >
                    <X size={14} />
                  </button>
                </div>
              {:else}
                <label
                  class="border-cn-border bg-cn-bg text-text-muted hover:border-cn-yellow/50 flex cursor-pointer items-center gap-2 rounded-xl border-2 border-dashed px-4 py-3 text-sm transition-colors {poster.uploading
                    ? 'pointer-events-none opacity-50'
                    : ''}"
                >
                  <ImagePlus size={18} class="text-text-muted/60 shrink-0" />
                  {poster.uploading
                    ? m.asso_calendar_poster_uploading()
                    : m.asso_calendar_poster_add_label()}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    class="sr-only"
                    onchange={onPosterPicked}
                  />
                </label>
              {/if}
            </div>
          {:else}
            <p class="text-text-muted text-xs">{m.asso_calendar_poster_after_save_note()}</p>
          {/if}
        {/if}

        <CoOwnerPicker
          bind:selectedIds={values.coOwnerIds}
          excludeId={values.targetAssociationId}
        />

        {#if capabilities.canLinkForm && linkableForms}
          <div class="border-cn-border/70 bg-cn-bg/30 space-y-3 rounded-xl border p-3">
            <p
              class="text-text-muted flex items-center gap-1 text-xs font-bold tracking-wide uppercase"
            >
              <Link2 size={14} />
              {m.asso_calendar_link_form_label()}
            </p>
            <div>
              <label class="text-text-main mb-1 block text-xs font-semibold" for="event-form-link"
                >{m.asso_calendar_form_label()}</label
              >
              <select
                id="event-form-link"
                bind:value={values.linkedFormId}
                class="border-cn-border text-text-main w-full rounded-xl border bg-(--cn-surface) px-3 py-2 text-sm"
              >
                <option value="">{m.asso_calendar_link_form_none_option()}</option>
                {#each linkableForms as f (f.id)}
                  <option value={f.id}>{f.title}</option>
                {/each}
              </select>
            </div>
          </div>
        {/if}

        {#if error}
          <p class="text-red-err text-sm">{error}</p>
        {/if}

        <div class="flex flex-wrap justify-end gap-2 pt-2">
          <button
            type="button"
            onclick={onClose}
            class="border-cn-border hover:bg-cn-bg rounded-xl border px-4 py-2 text-sm font-semibold"
          >
            {m.common_cancel_button()}
          </button>
          <button
            type="button"
            onclick={submit}
            disabled={saving}
            class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-50"
          >
            {saving ? savingLabel : submitLabel}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
