<script lang="ts">
  interface Props {
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
    loading?: boolean;
    class?: string;
    onclick?: (e: MouseEvent) => void;
    children?: import('svelte').Snippet;
    variant?: 'primary' | 'secondary' | 'outline' | 'ghost';
    [key: string]: any;
  }

  let {
    type = 'button',
    disabled = false,
    loading = false,
    class: className = '',
    onclick,
    children,
    variant = 'primary',
    ...rest
  }: Props = $props();

  const baseStyles =
    'inline-flex items-center justify-center gap-2 px-6 py-3 rounded-2xl font-bold text-base transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed';

  const variants = {
    primary: 'bg-cn-yellow text-cn-dark hover:bg-cn-yellow-hover hover:-translate-y-0.5 shadow-sm',
    secondary: 'bg-cn-surface text-text-main hover:bg-cn-border/50 border border-cn-border',
    outline: 'bg-transparent border-2 border-cn-dark text-cn-dark hover:bg-cn-dark/5',
    ghost: 'bg-transparent text-text-muted hover:text-text-main hover:bg-cn-surface/50',
  };
</script>

<button
  {type}
  disabled={disabled || loading}
  class="{baseStyles} {variants[variant]} {className}"
  {onclick}
  {...rest}
>
  {#if loading}
    <span
      class="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"
    ></span>
  {/if}
  {@render children?.()}
</button>
