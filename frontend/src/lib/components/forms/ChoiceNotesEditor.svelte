<script lang="ts">
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

  /**
   * THE TWO FREE TEXTS A MANAGER CAN GIVE A CHOICE QUESTION: an optional comment under it, and an
   * "Autre" option whose picker may type what they mean (owner, 2026-11-21 - people answer a
   * "Commentaire" question that follows a yes/no a third of the time, and a form with no "Autre"
   * forces a second question to say what was left out).
   *
   * The "Autre" switch adds or removes ONE option marked `other`; the option itself is edited as
   * any other in the options list above (its label, its price, its removal), so the switch always
   * reflects whether such an option exists. The text typed beside it is never required: a build
   * older than this one draws it as a plain option and could not satisfy a requirement.
   */
  interface Props {
    /** The choice question, mutated in place (a `$state` proxy held by the card). */
    item: {
      id?: string;
      allowComment?: boolean;
      options?: { id?: string; label: string; priceModifier?: number; other?: boolean }[];
    };
  }

  let { item }: Props = $props();

  const hasOther = $derived((item.options ?? []).some((option) => option.other));

  function setOther(on: boolean) {
    const rest = (item.options ?? []).filter((option) => !option.other);
    item.options = on
      ? [
          ...rest,
          {
            id: crypto.randomUUID(),
            label: m.form_option_other_label(),
            priceModifier: 0,
            other: true,
          },
        ]
      : rest;
    Log.d('ChoiceNotesEditor', `question ${item.id}: "Autre" option ${on ? 'added' : 'removed'}`);
  }
</script>

<div class="space-y-3" data-testid="choice-notes-editor">
  <Toggle
    label={m.form_builder_other_toggle()}
    hint={m.form_builder_other_hint()}
    bind:checked={() => hasOther, setOther}
  />
  <Toggle
    label={m.form_builder_comment_toggle()}
    hint={m.form_builder_comment_hint()}
    bind:checked={
      () => item.allowComment === true,
      (on) => {
        item.allowComment = on;
        Log.d('ChoiceNotesEditor', `question ${item.id}: comment ${on ? 'on' : 'off'}`);
      }
    }
  />
</div>
