<script lang="ts">
  import type { FormItem } from '$lib/forms/api';
  import ProfileBioMarkdown from '$lib/components/profile/ProfileBioMarkdown.svelte';
  import { associationLogoSrc } from '$lib/associations/api';
  import { IMAGE_BLOCK_TYPE, TEXT_BLOCK_TYPE, formBlockImageAlt } from '$lib/forms/formBlocks';

  /**
   * ONE TEXT OR IMAGE BLOCK OF A FORM BEING FILLED IN (`formBlocks.ts`): what the organiser says
   * between the questions. No number, no input, nothing bound - a block takes no answer.
   *
   * A text block's paragraph goes through the form description's own renderer
   * (`ProfileBioMarkdown`: Markdown, raw HTML drawn as inert components, link schemes allowlisted),
   * so the two read the same. An image block is drawn whole (`object-contain`), its src through the
   * public media base so a guest's browser and a native shell both reach it.
   */
  interface Props {
    item: FormItem;
    /** The form's title, which an image with no alt text and no caption is described by. */
    formTitle: string;
  }

  let { item, formTitle }: Props = $props();

  const imageSrc = $derived(
    item.type === IMAGE_BLOCK_TYPE ? associationLogoSrc(item.imageUrl) : undefined
  );
</script>

<section
  id={`b-${item.id}`}
  class="px-1 py-1 sm:px-2"
  data-testid="form-block"
  data-block-type={item.type}
>
  {#if item.type === TEXT_BLOCK_TYPE}
    {#if item.label?.trim()}
      <h2 class="text-text-main text-lg leading-snug font-bold whitespace-pre-line">
        {item.label}
      </h2>
    {/if}
    {#if item.description?.trim()}
      <div class={item.label?.trim() ? 'mt-1.5' : ''}>
        <ProfileBioMarkdown source={item.description} />
      </div>
    {/if}
  {:else if imageSrc}
    <figure class="border-cn-border/60 bg-cn-bg overflow-hidden rounded-2xl border">
      <img
        src={imageSrc}
        alt={formBlockImageAlt(item, formTitle)}
        class="mx-auto block h-auto max-h-[70vh] w-auto max-w-full object-contain"
        loading="lazy"
        decoding="async"
      />
      {#if item.label?.trim()}
        <figcaption class="text-text-muted px-4 py-2 text-xs whitespace-pre-line">
          {item.label}
        </figcaption>
      {/if}
    </figure>
  {/if}
</section>
