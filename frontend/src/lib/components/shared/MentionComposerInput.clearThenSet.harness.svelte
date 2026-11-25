<script lang="ts">
  /** Test harness: a one-way `value` / `onchange` parent, the way ChatComposer binds the field. */
  import { flushSync } from 'svelte';
  import MentionComposerInput from './MentionComposerInput.svelte';

  interface Api {
    type: (text: string) => void;
    send: (order: string) => void;
    load: (text: string) => void;
  }
  let { expose }: { expose: (api: Api) => void } = $props();
  let text = $state('');
  let input: MentionComposerInput;

  $effect(() => {
    expose({
      type(t) {
        const el = document.querySelector<HTMLElement>('[role="textbox"]')!;
        el.textContent = t;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      },
      // ChatComposer.submit clears the parent's text and then the field; the orders cover the
      // ways those two writes can interleave, and 'editor-only' a parent that kept its text.
      send(order) {
        if (order === 'parent-first') {
          text = '';
          input.clearEditor();
        } else if (order === 'editor-first') {
          input.clearEditor();
          text = '';
        } else if (order === 'flush-between') {
          text = '';
          flushSync();
          input.clearEditor();
        } else {
          input.clearEditor();
        }
      },
      load(t) {
        text = t;
      },
    });
  });
</script>

<MentionComposerInput bind:this={input} value={text} onchange={(v) => (text = v)} />
