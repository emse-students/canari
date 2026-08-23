<script lang="ts">
  import type { MembershipTier } from '$lib/associations/api';
  import Select from '$lib/components/ui/Select.svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * Picks one of an association's cotisation tiers - by NAME, always.
   *
   * The tier travels as an opaque `variantKey` and is displayed as `MembershipTier.name`, so no
   * slug, id or tag ever reaches the screen. It is also why this is a `<select>` over a known list
   * rather than the free-text autocomplete it replaced: a tier that can be typed can be mistyped,
   * and a mistyped tier grants a membership nobody can see.
   *
   * `null` is a real, meaningful value on both sides and the two meanings differ, so the caller
   * says which one it wants:
   *   - `anyTierLabel` given -> `null` means "any tier" (the member-price question);
   *   - otherwise `null` is the association's base tier, and only offered when one exists.
   */
  interface Props {
    /** Tiers to choose from, as returned by `listMembershipTiers`. */
    tiers: MembershipTier[];
    /** Selected tier's `variantKey`, or null. */
    value: string | null;
    /** Label above the picker. */
    label: string;
    /** Hint below it. */
    hint?: string;
    /**
     * When set, an extra first option carrying this label maps to `null` = every tier qualifies.
     * Omit it where `null` must keep its other meaning, the base tier.
     */
    anyTierLabel?: string;
    /** Whether the picker can be operated. */
    disabled?: boolean;
    /** Called with the chosen `variantKey`, or null. */
    onValueChange: (variantKey: string | null) => void;
  }

  let {
    tiers,
    value,
    label,
    hint,
    anyTierLabel,
    disabled = false,
    onValueChange,
  }: Props = $props();

  /**
   * `null` cannot be a `<select>` value, so it is carried as the empty string and mapped back on
   * the way out. A tier whose `variantKey` were literally '' would collide - the backend treats a
   * blank key as null anyway, so the two agree.
   */
  const ANY_OR_BASE = '';

  const options = $derived([
    ...(anyTierLabel !== undefined
      ? [{ value: ANY_OR_BASE, label: anyTierLabel }]
      : tiers.some((t) => t.variantKey === null)
        ? [{ value: ANY_OR_BASE, label: baseTierName() }]
        : []),
    ...tiers
      .filter((t) => t.variantKey !== null)
      .map((t) => ({ value: t.variantKey as string, label: t.name })),
  ]);

  /** The base tier's own product name, falling back to a generic label if it has none. */
  function baseTierName(): string {
    return tiers.find((t) => t.variantKey === null)?.name || m.form_cotisation_tier_base();
  }
</script>

<Select
  {label}
  {hint}
  {disabled}
  value={value ?? ANY_OR_BASE}
  {options}
  onValueChange={(v) => onValueChange(v === ANY_OR_BASE ? null : v)}
/>
