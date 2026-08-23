import { fetchCotisationOptions, type CotisationOptions } from '$lib/associations/api';
import type { CreateFormPayload, Form } from './api';

/**
 * The cotisation half of a form's configuration, as the create and edit screens hold it.
 *
 * Both screens used to keep these as loose `$state` variables and each built its own payload
 * fragment, which is how they came to disagree: one sent the member price only when a tag was set,
 * the other also when it was cleared. One shape, one reader, one writer.
 *
 * Prices are in EUROS here because that is what the inputs bind to; the conversion to cents
 * happens once, in `cotisationPayload`.
 */
export interface FormCotisationSettings {
  /** Whether cotisants get a reduced price. */
  memberPriceEnabled: boolean;
  /** Tier the member price is restricted to; null = any tier of the association. */
  memberPriceVariantKey: string | null;
  /** Member base price in euros; '' when the discount applies to the options only. */
  basePriceMember: number | '';
  /** Whether a paid submission grants the association's cotisation. */
  grantsCotisation: boolean;
  /** Tier granted; null = the association's base tier. */
  cotisationVariantKey: string | null;
}

/** A form that grants nothing and discounts nothing - the state of a new form. */
export function emptyCotisationSettings(): FormCotisationSettings {
  return {
    memberPriceEnabled: false,
    memberPriceVariantKey: null,
    basePriceMember: '',
    grantsCotisation: false,
    cotisationVariantKey: null,
  };
}

/** Reads the settings back off a loaded form, for the edit screen. */
export function cotisationSettingsOf(form: Form): FormCotisationSettings {
  return {
    memberPriceEnabled: form.memberPriceEnabled ?? false,
    memberPriceVariantKey: form.memberPriceVariantKey ?? null,
    basePriceMember: form.basePriceMember != null ? form.basePriceMember / 100 : '',
    grantsCotisation: form.grantsCotisation ?? false,
    cotisationVariantKey: form.cotisationVariantKey ?? null,
  };
}

/**
 * Turns the settings into the payload fields, in cents.
 *
 * Every field is always present, never conditionally spread: on the edit screen an ABSENT field
 * leaves the stored value alone, so a setting the user just switched off would stay on. Turning
 * something off has to be said out loud.
 *
 * A form that takes no payment carries neither setting - there is no price to reduce, and the
 * grant only ever runs from a payment being recorded.
 */
export function cotisationPayload(
  settings: FormCotisationSettings,
  requiresPayment: boolean
): Required<
  Pick<
    CreateFormPayload,
    | 'memberPriceEnabled'
    | 'memberPriceVariantKey'
    | 'basePriceMember'
    | 'grantsCotisation'
    | 'cotisationVariantKey'
  >
> {
  if (!requiresPayment) {
    return {
      memberPriceEnabled: false,
      memberPriceVariantKey: null,
      basePriceMember: null,
      grantsCotisation: false,
      cotisationVariantKey: null,
    };
  }
  return {
    memberPriceEnabled: settings.memberPriceEnabled,
    memberPriceVariantKey: settings.memberPriceEnabled ? settings.memberPriceVariantKey : null,
    basePriceMember:
      settings.memberPriceEnabled && settings.basePriceMember !== ''
        ? Math.round(Number(settings.basePriceMember) * 100)
        : null,
    grantsCotisation: settings.grantsCotisation,
    cotisationVariantKey: settings.grantsCotisation ? settings.cotisationVariantKey : null,
  };
}

/**
 * Whether a member price can be offered: there must be a price to reduce, an association to be a
 * member of, and a tier to hold. Offering it against an association with no cotisation would
 * produce a picker with nothing in it and a save the backend refuses.
 *
 * Not gated on any permission - showing a reduced price grants nothing.
 */
export function canOfferMemberPrice(
  requiresPayment: boolean,
  associationId: string,
  tierCount: number
): boolean {
  return requiresPayment && !!associationId && tierCount > 0;
}

/**
 * Whether the cotisation GRANT can be offered: everything the member price needs, plus the right to
 * hand a cotisation out.
 *
 * `mayGrant` is MANAGE_MEMBERS, the same right the manual roster add demands - a form that grants a
 * cotisation on payment does exactly what that button does, so it must not be a cheaper way in.
 * The server enforces it; this only keeps the screen honest about what it will accept.
 */
export function canGrantCotisation(
  requiresPayment: boolean,
  associationId: string,
  tierCount: number,
  mayGrant: boolean
): boolean {
  return mayGrant && canOfferMemberPrice(requiresPayment, associationId, tierCount);
}

/** Nothing offered, nothing grantable - the answer for an association we cannot read. */
const NO_COTISATION: CotisationOptions = { tiers: [], mayGrant: false };

/**
 * The association's tiers, and whether the caller may grant one.
 *
 * An unreadable answer becomes "no tiers, may not grant" on purpose: the settings hide themselves
 * when there is no tier, which is the honest outcome - better an absent control than a picker with
 * nothing in it and a save the backend will refuse. Failing CLOSED on `mayGrant` matters more: the
 * server refuses the save either way, so guessing `true` would only produce an option that looks
 * available and then fails.
 */
export async function cotisationOptionsFor(associationId: string): Promise<CotisationOptions> {
  if (!associationId) return NO_COTISATION;
  try {
    return await fetchCotisationOptions(associationId);
  } catch {
    return NO_COTISATION;
  }
}

/**
 * Forgets which tier was chosen, for use when the beneficiary association changes.
 *
 * A `variantKey` only means anything relative to one association's catalogue, so keeping it across
 * a change of beneficiary would save the form granting a membership of an association nobody
 * picked - and the backend would accept it whenever the two happened to share a tier name.
 */
export function forgetTierSelection(settings: FormCotisationSettings): void {
  settings.memberPriceVariantKey = null;
  settings.cotisationVariantKey = null;
}
