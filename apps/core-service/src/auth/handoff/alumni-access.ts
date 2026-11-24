/**
 * THE ALUMNI ACCESS RULE (D42-D44, owner 2026-11-23), AS THE HANDOFF GATE RE-EVALUATES IT.
 *
 * MiConnect decides it with three expression policies: the link step's reminder and block on the
 * authorization flow (`miconnect-alumni-link-reminder` / `-required`, 45-consent.yaml) and the
 * MiGallery / Le Cercle gate (`miconnect-access-window-post-or-cotisant` plus the group
 * `acces-<app>`, 60-applications.yaml). WHY A SECOND IMPLEMENTATION: Canari's sign-in handoff must
 * not sign a person into a site MiConnect would stop them at, and it cannot ask MiConnect -
 * authentik 2026.8 honours `check_access?for_user` for a superuser only and silently answers for
 * the caller otherwise, the same reason the terms answer is re-derived from `cgu_version`. So the
 * mint reads the inputs and answers here, and only for those exact bindings (an allowlist in
 * {@link MiconnectReaderClient}); anything else bound still refuses `policy_bound`.
 *
 * TWO IMPLEMENTATIONS OF ONE RULE DRIFT UNLESS ONE TABLE DRIVES BOTH: `libs/contracts/alumni-access.json`
 * holds the constants and the cases; `alumni-access.spec.ts` runs every case here and asserts
 * {@link ALUMNI_ACCESS} equals its constants, and `infrastructure/authentik/test-consent-flow.py`
 * runs every case through the real flow and policy engine. Dates are ISO `YYYY-MM-DD` strings, so a
 * comparison is a string comparison and no time zone enters it once "today" is taken.
 */

/** The rule's constants - equal, field for field, to `constants` in libs/contracts/alumni-access.json. */
export const ALUMNI_ACCESS = {
  /** The zone "today" is read in, on both sides. */
  timeZone: 'Europe/Paris',
  /** The free window (D42): a cursus with entry year P opens the gated sites until `P+5`-`08-31`. */
  windowYears: 5,
  windowLastDay: '08-31',
  /** The link reminder (D44) starts `P+1`-`09-01`, P the EARLIEST cursus entry year. */
  reminderYears: 1,
  reminderFrom: '09-01',
  /** The link is required from `P+2`-`02-01`... */
  blockingYears: 2,
  blockingFrom: '02-01',
  /** ...and never before this launch grace (D44). */
  graceUntil: '2027-02-01',
  /** A post that opens the gated sites whatever the cursus: staff are not alumni. */
  staffPosts: ['EMSE', 'ME', 'ALUMNI'],
} as const;

/** What the rule reads about a person - each field is a MiConnect user attribute or relation. */
export interface AlumniFacts {
  /** The integer entry years of `attributes.profile.cursus[].promo`. */
  promos: number[];
  /** `attributes.profile.posts`. */
  posts: string[];
  /** `attributes.alumni`, the cotisant read written at every Alumni sign-in; null when never read. */
  alumni: { cotisant?: unknown; read_on?: unknown } | null;
  /** The names of the groups the user is DIRECTLY in. */
  groups: string[];
  /** An Alumni user-source connection exists. */
  linked: boolean;
}

/** The D44 page the authorization flow shows: none, the skippable reminder, or the block. */
export type AlumniLinkStep = 'none' | 'reminder' | 'required';

/** The Paris date of `now`, `YYYY-MM-DD`. */
export function parisToday(now: Date): string {
  // en-CA formats a date as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ALUMNI_ACCESS.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** The latest of two ISO dates. */
function later(a: string, b: string): string {
  return a > b ? a : b;
}

/** The link step a person meets on `today` (the two D44 policies of 45-consent.yaml). */
export function alumniLinkStep(facts: AlumniFacts, today: string): AlumniLinkStep {
  if (facts.promos.length === 0 || facts.linked) return 'none';
  const first = Math.min(...facts.promos);
  const blocking = later(
    `${first + ALUMNI_ACCESS.blockingYears}-${ALUMNI_ACCESS.blockingFrom}`,
    ALUMNI_ACCESS.graceUntil
  );
  if (today >= blocking) return 'required';
  if (today >= `${first + ALUMNI_ACCESS.reminderYears}-${ALUMNI_ACCESS.reminderFrom}`) {
    return 'reminder';
  }
  return 'none';
}

/**
 * Whether MiGallery or Le Cercle lets a person in on `today` (engine mode `any` over the policy
 * `miconnect-access-window-post-or-cotisant` and the group `acces-<application>`). A membership
 * INHERITED through a child group is not read here: such a person is refused, Canari opens the site
 * plainly, and MiConnect itself lets them in - the safe direction.
 */
export function alumniGateAdmits(facts: AlumniFacts, application: string, today: string): boolean {
  const staff: readonly string[] = ALUMNI_ACCESS.staffPosts;
  if (facts.posts.some((post) => staff.includes(post))) return true;
  const windowOpen = facts.promos.some(
    (promo) => today <= `${promo + ALUMNI_ACCESS.windowYears}-${ALUMNI_ACCESS.windowLastDay}`
  );
  if (windowOpen) return true;
  const readOn = facts.alumni?.read_on;
  if (
    facts.alumni?.cotisant === true &&
    typeof readOn === 'string' &&
    readOn.slice(0, 4) === today.slice(0, 4)
  ) {
    return true;
  }
  return facts.groups.includes(`acces-${application}`);
}

/** Whether a value is a plain JSON object (not null, not an array). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The cursus entry years, posts and Alumni read of a MiConnect user's attributes, as the rule reads
 * them - the same reading as MiConnect's policies: an entry year is an integer (a boolean is not) in
 * a cursus entry that is an object; anything else is ignored. The malformed shapes are cases of
 * libs/contracts/alumni-access.json, run by both sides.
 */
export function alumniProfileFacts(
  attributes: Record<string, unknown>
): Omit<AlumniFacts, 'linked' | 'groups'> {
  const profile = isObject(attributes.profile) ? attributes.profile : {};
  const cursus: unknown[] = Array.isArray(profile.cursus) ? profile.cursus : [];
  const posts: unknown[] = Array.isArray(profile.posts) ? profile.posts : [];
  return {
    promos: cursus
      .map((c) => (isObject(c) ? c.promo : undefined))
      .filter((p): p is number => typeof p === 'number' && Number.isInteger(p)),
    posts: posts.filter((p): p is string => typeof p === 'string'),
    alumni: isObject(attributes.alumni)
      ? (attributes.alumni as { cotisant?: unknown; read_on?: unknown })
      : null,
  };
}
