<script lang="ts">
  import Input from '$lib/components/ui/Input.svelte';

  let { item = $bindable(), onRemove } = $props<{
    item: any;
    onRemove: () => void;
  }>();

  const formItemTypes = [
    { value: 'short_text', label: 'Short Answer' },
    { value: 'long_text', label: 'Paragraph' },
    { value: 'single_choice', label: 'Single Choice (Radio)' },
    { value: 'multiple_choice', label: 'Multiple Choice (Checkbox)' },
    { value: 'dropdown', label: 'Dropdown' },
    { value: 'linear_scale', label: 'Linear Scale' },
    { value: 'matrix_single', label: 'Single Choice Grid' },
    { value: 'matrix_multiple', label: 'Checkbox Grid' },
  ];

  function addOption() {
    if (!item.options) item.options = [];
    item.options = [...item.options, { label: 'New Option', priceModifier: 0 }];
  }

  function removeOption(idx: number) {
    if (!item.options) return;
    item.options = item.options.filter((_: any, i: number) => i !== idx);
  }

  function addRow() {
    if (!item.rows) item.rows = [];
    item.rows = [...item.rows, `Row ${item.rows.length + 1}`];
  }

  function removeRow(idx: number) {
    if (!item.rows) return;
    item.rows = item.rows.filter((_: any, i: number) => i !== idx);
  }

  // Ensure defaults
  if (!item.scale) item.scale = { min: 1, max: 5 };
  if (!item.options) item.options = [];
  if (!item.rows) item.rows = [];
</script>

<div
  class="relative p-5 bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm group transition-all hover:shadow-md"
>
  <button
    class="absolute top-3 right-3 p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all opacity-0 group-hover:opacity-100"
    onclick={onRemove}
    type="button"
    title="Remove Question"
  >
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path
        d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"
      /><line x1="10" x2="10" y1="11" y2="17" /><line x1="14" x2="14" y1="11" y2="17" />
    </svg>
  </button>

  <div class="grid grid-cols-1 md:grid-cols-12 gap-4 mb-4 pr-8">
    <div class="md:col-span-8">
      <Input label="Question" bind:value={item.label} />
    </div>
    <div class="md:col-span-4">
      <span class="block text-sm font-bold mb-1 ml-1">Type</span>
      <div class="relative">
        <select
          bind:value={item.type}
          class="w-full appearance-none rounded-xl border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all pr-8"
        >
          {#each formItemTypes as type (type.value)}
            <option value={type.value}>{type.label}</option>
          {/each}
        </select>
        <div
          class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-gray-500"
        >
          <svg class="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"
            ><path
              d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z"
            /></svg
          >
        </div>
      </div>
    </div>
  </div>

  <div class="mb-5 flex justify-end">
    <label class="flex items-center gap-2 cursor-pointer select-none">
      <input
        type="checkbox"
        bind:checked={item.required}
        class="appearance-none w-5 h-5 rounded border border-gray-300 checked:bg-blue-600 checked:border-blue-600 relative transition-all cursor-pointer before:content-[''] before:absolute before:inset-0 before:m-auto before:w-3 before:h-2 before:border-l-2 before:border-b-2 before:border-white before:rotate-[-45deg] before:opacity-0 checked:before:opacity-100"
      />
      <span class="text-sm font-medium">Answer required</span>
    </label>
  </div>

  <!-- Type Specific Rendering -->
  {#if ['short_text', 'long_text'].includes(item.type)}
    <div
      class="p-4 bg-gray-50 dark:bg-gray-700/50 border border-dashed border-gray-200 dark:border-gray-600 rounded-xl text-sm text-gray-500 dark:text-gray-400 italic text-center"
    >
      User will see a {item.type === 'short_text' ? 'single-line' : 'multi-line'} text input here.
    </div>
  {:else if item.type === 'linear_scale'}
    <div
      class="p-4 bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-600 rounded-xl"
    >
      <div class="flex items-center gap-4 mb-4">
        <div class="flex items-center gap-3">
          <span class="text-sm font-bold">Range:</span>
          <select
            bind:value={item.scale.min}
            class="bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 text-sm rounded-lg px-2 py-1 outline-none"
          >
            <option value={0}>0</option>
            <option value={1}>1</option>
          </select>
          <span class="text-xs text-gray-500 uppercase font-bold">to</span>
          <select
            bind:value={item.scale.max}
            class="bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 text-sm rounded-lg px-2 py-1 outline-none"
          >
            {#each Array.from({ length: 9 }, (_, i) => i + 2) as val (val)}
              <option value={val}>{val}</option>
            {/each}
          </select>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-4">
        <Input
          label={`Label for ${item.scale.min} (Optional)`}
          bind:value={item.scale.minLabel}
          placeholder="e.g. Strongly Disagree"
        />
        <Input
          label={`Label for ${item.scale.max} (Optional)`}
          bind:value={item.scale.maxLabel}
          placeholder="e.g. Strongly Agree"
        />
      </div>
    </div>
  {:else}
    <!-- Options / Columns -->
    <div class="space-y-3">
      <div
        class="text-xs font-bold text-gray-500 uppercase tracking-wider flex justify-between items-end"
      >
        <span
          >{['matrix_single', 'matrix_multiple'].includes(item.type) ? 'Columns' : 'Options'}</span
        >
      </div>

      <div class="space-y-2 pl-1">
        {#each item.options as opt, optIdx (optIdx)}
          <div class="flex gap-3 items-center group/option">
            <div class="w-5 flex justify-center text-gray-400 pt-3">
              <span class="text-xs font-mono opacity-60">{optIdx + 1}.</span>
            </div>

            <div class="flex-1">
              <Input
                placeholder={['matrix_single', 'matrix_multiple'].includes(item.type)
                  ? 'Column Label'
                  : 'Option Label'}
                bind:value={opt.label}
              />
            </div>

            {#if !['matrix_single', 'matrix_multiple'].includes(item.type)}
              <div class="w-24 relative group/price">
                <Input
                  type="number"
                  placeholder="+Price"
                  bind:value={opt.priceModifier}
                  step="0.01"
                />
              </div>
            {/if}

            <div class="pt-1">
              <button
                class="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                onclick={() => removeOption(optIdx)}
                type="button"
                title="Remove option"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>
        {/each}
      </div>

      <div class="pl-8">
        <button
          class="text-xs flex items-center gap-1 text-blue-600 font-bold hover:underline py-1"
          onclick={addOption}
          type="button"
        >
          <span class="text-lg leading-none">+</span> Add {[
            'matrix_single',
            'matrix_multiple',
          ].includes(item.type)
            ? 'Column'
            : 'Option'}
        </button>
      </div>
    </div>

    <!-- Rows for Matrix -->
    {#if ['matrix_single', 'matrix_multiple'].includes(item.type)}
      <div class="mt-6 pt-4 border-t border-dashed border-gray-200 dark:border-gray-700 space-y-3">
        <div class="text-xs font-bold text-text-muted uppercase tracking-wider">Rows</div>

        <div class="space-y-2 pl-1">
          {#each item.rows as _row, rowIdx (rowIdx)}
            <div class="flex gap-3 items-center">
              <div class="w-5 text-gray-400 text-xs text-right opacity-50 font-mono pt-3">
                {rowIdx + 1}.
              </div>
              <div class="flex-1">
                <Input placeholder="Row Label" bind:value={item.rows[rowIdx]} />
              </div>
              <div class="pt-1">
                <button
                  class="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                  onclick={() => removeRow(rowIdx)}
                  type="button"
                  title="Remove row"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            </div>
          {/each}
        </div>

        <div class="pl-8">
          <button
            class="text-xs flex items-center gap-1 text-blue-600 font-bold hover:underline py-1"
            onclick={addRow}
            type="button"
          >
            <span class="text-lg leading-none">+</span> Add Row
          </button>
        </div>
      </div>
    {/if}
  {/if}
</div>
