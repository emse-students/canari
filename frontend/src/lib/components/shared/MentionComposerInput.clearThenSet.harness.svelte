<script lang="ts">
  /**
   * Test harness: the parent the way MainChatPage is. The text is a `$derived` over a SvelteMap
   * (`messaging.draftFor`); a send deletes the draft and THEN clears the field, as `handleSendChat`
   * and `ChatComposer.submit` do. Plain `$state`, a `$derived` of `$state` and a proxy do not show
   * the defect (Svelte 5.59.1).
   */
  import { SvelteMap } from 'svelte/reactivity';
  import MentionComposerInput from './MentionComposerInput.svelte';

  interface Api {
    type: (text: string) => void;
    send: () => void;
    load: (text: string) => void;
  }
  let { expose }: { expose: (api: Api) => void } = $props();
  const drafts = new SvelteMap<string, string>();
  const text = $derived(drafts.get('c') ?? '');
  const set = (t: string) => (t ? drafts.set('c', t) : drafts.delete('c'));
  let input: MentionComposerInput;

  $effect(() => {
    expose({
      type(t) {
        const el = document.querySelector<HTMLElement>('[role="textbox"]')!;
        el.textContent = t;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      },
      send() {
        set('');
        input.clearEditor();
      },
      load: set,
    });
  });
</script>

<MentionComposerInput bind:this={input} value={text} onchange={set} />
