declare module 'svelte-markdown' {
  import { SvelteComponent } from 'svelte';

  export default class SvelteMarkdown extends SvelteComponent<{
    source?: string;
  }> {}
}
