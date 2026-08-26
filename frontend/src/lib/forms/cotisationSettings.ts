import { fetchCotisationOptions, type CotisationOptions } from '$lib/associations/api';
import type { CreateFormPayload, Form } from './api';

/**
 * The cotisation GRANT half of a form's configuration, as the create and edit screens hold it.
 *
 * The member-PRICE half used to live here too. It is now one criterion of the pricing grid
 * (`priceMatrix.ts`), because a form needs to discriminate on more than membership and two
 * mechanisms for "some people pay less" is the gas factory this module was cleaned out of. What
 * stays is the grant, which is a different thing entirely: a price asks who somebody IS, a grant
 * changes it.
 */
export interface FormCotisationSettings {
  /** Whether a paid submission grants the association's cotisation. */
  grantsCotisation: boolean;
  /** Tier granted; null = the association's base tier. */
  cotisationVariantKey: string | null;
}

/** A form that grants nothing - the state of a new form. */
export function emptyCotisationSettings(): FormCotisationSettings {
  return { grantsCotisation: false, cotisationVariantKey: null };
}

/** Reads the settings back off a loaded form, for the edit screen. */
export function cotisationSettingsOf(form: Form): FormCotisationSettings {
  return {
    grantsCotisation: form.grantsCotisation ?? false,
    cotisationVariantKey: form.cotisationVariantKey ?? null,
  };
}

/**
 * Turns the settings into the payload fields.
 *
 * Every field is always present, never conditionally spread: on the edit screen an ABSENT field
 * leaves the stored value alone, so a setting the user just switched off would stay on. Turning
 * something off has to be said out loud.
 *
 * A form that takes no payment grants nothing - the grant only ever runs from a payment being
 * recorded, so it is a setting that could not fire.
 */
export function cotisationPayload(
  settings: FormCotisationSettings,
  requiresPayment: boolean
): Required<Pick<CreateFormPayload, 'grantsCotisation' | 'cotisationVariantKey'>> {
  if (!requiresPayment) return { grantsCotisation: false, cotisationVariantKey: null };
  return {
    grantsCotisation: settings.grantsCotisation,
    cotisationVariantKey: settings.grantsCotisation ? settings.cotisationVariantKey : null,
  };
}

/**
 * Why the cotisation GRANT cannot be offered - or null when it can.
 *
 * A REASON rather than a boolean, because the four conditions are invisible from the screen and one
 * of them (`mayGrant`, which is MANAGE_MEMBERS) is not even a form setting: a manager who is told
 * only "unavailable" has nothing to act on, and the one sentence that used to be shown named the
 * three cheap causes and not that one.
 *
 * `mayGrant` is the same right the manual roster add demands - a form that grants a cotisation on
 * payment does exactly what that button does, so it must not be a cheaper way in. The server
 * enforces all four; this keeps the screen honest about what it will accept.
 *
 * Reported in the order the manager can act on: payment first (their own switch, one section up),
 * then the beneficiary, then that association's catalogue, then the right they do not hold.
 */
export type CotisationGrantBlocker = 'no-payment' | 'no-association' | 'no-cotisation' | 'no-right';

export function cotisationGrantBlocker(
  requiresPayment: boolean,
  associationId: string,
  tierCount: number,
  mayGrant: boolean
): CotisationGrantBlocker | null {
  if (!requiresPayment) return 'no-payment';
  if (!associationId) return 'no-association';
  if (tierCount === 0) return 'no-cotisation';
  if (!mayGrant) return 'no-right';
  return null;
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
  settings.cotisationVariantKey = null;
}
