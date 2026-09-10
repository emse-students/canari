/**
 * THE PARTNERSHIP EDITOR MUST CARRY EVERY FIELD THE API ACCEPTS, and this is what says so.
 *
 * WHY IT EXISTS. Until 2026-09-10 the manage screen could SET eight fields at creation and CHANGE
 * three afterwards. The other five - title, description, link, shared code, static text - were
 * frozen the moment the card existed, so fixing a typo meant deleting the partnership and
 * recreating it, which destroys the claim ledger with it. Reported by the user: *"pas tres
 * intuitive, et qui ne permet pas d'editer un partenariat"*.
 *
 * WHY IT IS A TEST OVER SOURCE RATHER THAN A RENDER. The defect is not "this control misbehaves",
 * it is "this control was never added" - an ABSENCE, which no rendering test asks about unless
 * somebody already thought to. The population is what has to be checked: every field the payload
 * types accept, derived from `api.ts` rather than listed here, so a field added to the API
 * tomorrow fails this test until the form shows it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const api = read('../../../associations/api.ts');
const editor = read('./PartnershipEditor.svelte');
const tab = read('./EditPartnershipsTab.svelte');

/** Property names declared directly in a type or interface block. */
function ownProperties(block: string): string[] {
  return block
    .split('\n')
    .map((line) => /^\s{2}(\w+)\??:\s/.exec(line)?.[1])
    .filter((n): n is string => Boolean(n));
}

const createBlock = api.slice(
  api.indexOf('export interface CreatePartnershipCardPayload {'),
  api.indexOf('export type UpdatePartnershipCardPayload')
);
const updateBlock = api.slice(
  api.indexOf('export type UpdatePartnershipCardPayload'),
  api.indexOf('export async function listAllPartnerships')
);

/**
 * THE TWO SETS ARE DERIVED SEPARATELY, AND THAT IS THE WHOLE POINT.
 *
 * The first version of this file pooled them and checked the union against both calls joined
 * together - so deleting `link` from the UPDATE payload passed, because `link` was still in the
 * CREATE one. A test that cannot tell the two flows apart cannot guard the defect it was written
 * for, which was precisely "you can set this once and never change it". Proven by mutation.
 */
const CREATE_FIELDS = ownProperties(createBlock).sort();

/**
 * `UpdatePartnershipCardPayload` is `Partial<Omit<Create..., 'a' | 'b'>> & { own props }`, so its
 * field set is read off the type expression rather than listed - an added `Omit` member changes
 * what this test demands, on the day it is committed.
 */
const UPDATE_FIELDS = (() => {
  const omitted = new Set(
    [
      ...(/Omit<CreatePartnershipCardPayload,([^>]*)>/.exec(updateBlock)?.[1] ?? '').matchAll(
        /'(\w+)'/g
      ),
    ].map((m) => m[1])
  );
  return [
    ...new Set([...CREATE_FIELDS.filter((f) => !omitted.has(f)), ...ownProperties(updateBlock)]),
  ].sort();
})();

const ALL_FIELDS = [...new Set([...CREATE_FIELDS, ...UPDATE_FIELDS])].sort();

/**
 * The arguments of every call to `fn` in `source`, as source text.
 *
 * IT MATCHES PARENTHESES RATHER THAN SEARCHING FOR A FIELD NAME, and the difference is not
 * pedantry: the first version of this file looked for `title:` anywhere in the list component and
 * accused `m.asso_partnership_delete_confirm({ title: card.title })` - a message argument - of
 * being a write. A test that cannot tell a write from a mention reports the wrong thing
 * confidently, which is the class of defect this repository spends most of its time on.
 */
function callArgs(source: string, fn: string): string[] {
  const out: string[] = [];
  const needle = `${fn}(`;
  let at = source.indexOf(needle);
  while (at !== -1) {
    let depth = 0;
    let i = at + needle.length - 1;
    for (; i < source.length; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')' && --depth === 0) break;
    }
    out.push(source.slice(at + needle.length, i));
    at = source.indexOf(needle, i);
  }
  return out;
}

/**
 * Every field name appearing as a property KEY in a write call's payload.
 *
 * Both spellings count - `membersOnly,` (shorthand) and `badgeText: ...` - because which one a
 * line uses is a formatting accident, not a statement about whether the field is sent. The
 * lookbehind is what keeps `card.isActive` on the right-hand side from reading as a key.
 */
function fieldsWritten(source: string, fn: string, fields: string[]): string[] {
  const calls = callArgs(source, fn).join('\n');
  return fields.filter((f) => new RegExp(`(?<![.\\w])${f}\\s*[,:]`).test(calls));
}

/**
 * Fields a control in the LIST may write, and why - everything else belongs to the editor alone.
 *
 * Keyed by field so a second entry has to be argued for rather than appended.
 */
const WRITTEN_BY_THE_LIST_TOO: Record<string, string> = {
  isActive:
    'the list carries a quick activate/deactivate shortcut: hiding an expired offer is a real ' +
    'need that does not deserve opening a form. It is TWO TRIGGERS, ONE WRITE - both call ' +
    'updatePartnershipCard - and the editor still shows the field, because an editor that omitted ' +
    'it would be the same "where do I change this" this change removes.',
};

describe('the partnership editor is the one place a partnership is written', () => {
  it('finds both payload sets at all, so an empty derivation cannot pass', () => {
    // Floors rather than equalities: adding a field to the API must fail the assertions below,
    // not this one.
    expect(CREATE_FIELDS.length).toBeGreaterThanOrEqual(8);
    expect(CREATE_FIELDS).toContain('claimMode');
    expect(UPDATE_FIELDS.length).toBeGreaterThanOrEqual(8);
    expect(UPDATE_FIELDS).toContain('isActive');
    // The one field the server refuses to change is the one that must NOT be in the update set.
    expect(UPDATE_FIELDS).not.toContain('claimMode');
  });

  it('holds form state for every field either payload accepts', () => {
    const missing = ALL_FIELDS.filter((f) => !new RegExp(`let ${f}\\s*=\\s*\\$state`).test(editor));
    expect(
      missing,
      `PartnershipEditor.svelte has no form state for: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('sends every CREATE field when creating', () => {
    const sent = fieldsWritten(editor, 'createPartnershipCard', CREATE_FIELDS);
    const missing = CREATE_FIELDS.filter((f) => !sent.includes(f));
    expect(missing, `the create call omits: ${missing.join(', ')}`).toEqual([]);
  });

  it('sends every UPDATE field when editing - which is the whole reported defect', () => {
    // THE ONE THAT MATTERS. "You can set it once and never change it" is precisely a field present
    // in the create payload and absent from the update one, and pooling the two calls made that
    // invisible - proven by mutation before this assertion was split out.
    const sent = fieldsWritten(editor, 'updatePartnershipCard', UPDATE_FIELDS);
    const missing = UPDATE_FIELDS.filter((f) => !sent.includes(f));
    expect(
      missing,
      `the update call omits ${missing.join(', ')} - those fields would be settable at creation ` +
        `and frozen for ever, which is the defect this editor was written to remove.`
    ).toEqual([]);
  });

  it('is the only component that edits them - the list writes only what it declares', () => {
    const alsoInTheList = fieldsWritten(tab, 'updatePartnershipCard', ALL_FIELDS);
    const undeclared = alsoInTheList.filter((f) => !(f in WRITTEN_BY_THE_LIST_TOO));
    expect(
      undeclared,
      `EditPartnershipsTab.svelte writes ${undeclared.join(', ')} without declaring why. Either ` +
        `move it into PartnershipEditor - which is the whole point of that component - or add it ` +
        `to WRITTEN_BY_THE_LIST_TOO with the reason.`
    ).toEqual([]);
  });

  it('has no stale exception, so a shortcut that was removed cannot be forgotten', () => {
    const written = fieldsWritten(tab, 'updatePartnershipCard', ALL_FIELDS);
    const stale = Object.keys(WRITTEN_BY_THE_LIST_TOO).filter((f) => !written.includes(f));
    expect(
      stale,
      `WRITTEN_BY_THE_LIST_TOO names ${stale.join(', ')}, which the list no longer writes`
    ).toEqual([]);
  });

  it('renders the immutable claim mode rather than hiding it', () => {
    // The server refuses a claimMode change - existing claims would be stranded - and the decision
    // (user, 2026-09-10) was to SHOW it read-only with the reason. A field that silently vanishes
    // between the two flows is what made this screen unreadable in the first place.
    expect(editor).toContain('asso_partnership_mode_locked_hint');
    expect(api).toContain("Omit<CreatePartnershipCardPayload, 'claimMode'");
  });
});
