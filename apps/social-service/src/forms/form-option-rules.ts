/**
 * WHICH FORM OPTIONS RULE EACH OTHER OUT - ONE RULE, READ BY THE EDITOR AND BY THE SERVER.
 *
 * A form's options are switched on one at a time, in whatever order the manager clicks. A rule
 * written as "this switch is shut while that one is on", once per switch, is a rule written twice,
 * and the two halves drift: "tarifs differencies" shut "Formulaire public", but switching the form
 * public FIRST and adding the grid afterwards was accepted (owner, 2026-11-06). Here every
 * incompatibility is ONE PAIR in one table, so the answer cannot depend on the order: the editor
 * asks `conflictsIfEnabled` before offering a switch, whichever was on first, and the server asks
 * `formOptionConflicts` of the form it is about to save and refuses with the conflict's CODE.
 *
 * THIS FILE IS COPIED, BYTE FOR BYTE, between the frontend and social-service, and the copy is
 * declared in `.github/scripts/lib/declared-duplicates.mjs` so a gate refuses the two drifting
 * apart. It is copied rather than shared because there is no TS library between `frontend/` and
 * `apps/` (see `answerText.ts`, the same arrangement). It imports nothing, and each side derives
 * the booleans below from its own model of a form.
 *
 * What is NOT here, on purpose: a public form forcing several answers on (a coupling the editor
 * applies, not a conflict to refuse), and a public form's cash deadline and free "everyone else"
 * price (they read a field's value or a question's reachability, not two options).
 */

/**
 * The generated group every criterion of a price grid ends with: "everyone else". It is where a
 * guest lands on every criterion about who the person is - a guest has no promo, no formation and
 * no cotisation - so it is the tier a guest pays.
 */
export const OTHERS_BUCKET_ID = '_others';

/** The options of a form that can rule each other out, each reduced to whether it is on. */
export interface FormOptionState {
  /** Answers are stored without their author (`forms.anonymous`). */
  anonymous: boolean;
  /** Answerable without an account, from the `/f/:id` link (`forms.isPublic`). */
  isPublic: boolean;
  /** The form can charge: payment on, a base price, a grid, cash, or an option supplement. */
  takesPayment: boolean;
  /** Payment grants a cotisation of the beneficiary association. */
  grantsCotisation: boolean;
  /**
   * Who may answer, or see a question, depends on WHO the person is: an audience restriction
   * (`submitCondition`), or a question shown by promo, formation or cotisation. An ANSWER criterion
   * is not one: a guest answers too.
   */
  restrictsAudience: boolean;
  /** A question asks for a file. */
  hasFileQuestion: boolean;
}

/** One option, by its key in `FormOptionState`. */
export type FormOption = keyof FormOptionState;

/**
 * Every pair of options that cannot both be on, with the code a refusal carries. Read as "a ... has
 * no ...": an anonymous form keeps no identity, which a payment, a grant or a file would reveal; a
 * guest has no account and no profile, which a restricted audience, a grant or a file would need.
 *
 * A price grid on promo, formation or cotisation is NOT here beside `isPublic`: a guest falls in the
 * "everyone else" group of each such criterion and pays that tier (owner, 2026-11-06).
 */
export const FORM_OPTION_CONFLICTS = {
  FORM_ANONYMOUS_PAYMENT: ['anonymous', 'takesPayment'],
  FORM_ANONYMOUS_COTISATION_GRANT: ['anonymous', 'grantsCotisation'],
  FORM_ANONYMOUS_FILE: ['anonymous', 'hasFileQuestion'],
  FORM_PUBLIC_AUDIENCE: ['isPublic', 'restrictsAudience'],
  FORM_PUBLIC_COTISATION_GRANT: ['isPublic', 'grantsCotisation'],
  FORM_PUBLIC_FILE: ['isPublic', 'hasFileQuestion'],
} as const satisfies Record<string, readonly [FormOption, FormOption]>;

/** The code of one incompatible pair. */
export type FormOptionConflict = keyof typeof FORM_OPTION_CONFLICTS;

/** A public form whose grid leaves a guest no price at all. Not a pair: it reads the grid's cells. */
export const FORM_PUBLIC_GUEST_TIER_UNAVAILABLE = 'FORM_PUBLIC_GUEST_TIER_UNAVAILABLE';

/** Every conflict a refusal can carry: a pair of options, or the guest tier of a public grid. */
export type FormConfigConflict = FormOptionConflict | typeof FORM_PUBLIC_GUEST_TIER_UNAVAILABLE;

/** The pairs both of whose options are on, in table order. Empty for a coherent form. */
export function formOptionConflicts(state: FormOptionState): FormOptionConflict[] {
  return (Object.keys(FORM_OPTION_CONFLICTS) as FormOptionConflict[]).filter((code) =>
    FORM_OPTION_CONFLICTS[code].every((option) => state[option])
  );
}

/**
 * What switching `option` on would collide with, given everything else as it is - the reasons its
 * switch is shut. Empty when it may be switched on, or when it already is (the way out is open).
 */
export function conflictsIfEnabled(
  state: FormOptionState,
  option: FormOption
): FormOptionConflict[] {
  if (state[option]) return [];
  return formOptionConflicts({ ...state, [option]: true }).filter((code) =>
    (FORM_OPTION_CONFLICTS[code] as readonly FormOption[]).includes(option)
  );
}

/**
 * Whether a condition (who may answer, or when a question is shown) names who the person IS - a
 * promo, a formation, a cotisation held or not - rather than only an answer.
 */
export function conditionNamesProfile(condition: object | null | undefined): boolean {
  if (condition == null) return false;
  return Object.entries(condition).some(([key, value]) => key !== 'answer' && value != null);
}

/** The shape of a price grid this file reads: the kind of each criterion, and the cells by key. */
export interface GuestPricedGrid {
  dimensions: ReadonlyArray<{ kind: string }>;
  cells: Readonly<Record<string, number | null>>;
}

/**
 * Whether a cell is one a GUEST can land in: on every criterion about who the person is, the
 * "everyone else" group. Answer criteria are free - a guest answers like anybody.
 */
export function isGuestCell(grid: GuestPricedGrid, key: string): boolean {
  const parts = key.split('|');
  return grid.dimensions.every((d, i) => d.kind === 'answer' || parts[i] === OTHERS_BUCKET_ID);
}

/**
 * Whether a public form's grid leaves a guest NO price: every cell a guest can land in is marked
 * unavailable. The "everyone else" tier always exists (a grid is complete), but a manager can close
 * it, and a link handed to guests who may not answer is a public form in name only - refused, not
 * shown as a form every guest is turned away from.
 */
export function guestTierUnavailable(grid: GuestPricedGrid | null | undefined): boolean {
  if (!grid || grid.dimensions.length === 0) return false;
  const guestCells = Object.keys(grid.cells).filter((key) => isGuestCell(grid, key));
  return guestCells.length > 0 && guestCells.every((key) => grid.cells[key] === null);
}

/**
 * Every conflict of a form about to be saved: the pairs, then, on a public form, the guest tier.
 * The one call both the save button and the server make.
 */
export function formConfigConflicts(
  state: FormOptionState,
  grid: GuestPricedGrid | null | undefined
): FormConfigConflict[] {
  const conflicts: FormConfigConflict[] = formOptionConflicts(state);
  if (state.isPublic && guestTierUnavailable(grid)) {
    conflicts.push(FORM_PUBLIC_GUEST_TIER_UNAVAILABLE);
  }
  return conflicts;
}
