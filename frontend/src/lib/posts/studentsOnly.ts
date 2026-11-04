import { Log } from '$lib/utils/Log';

/**
 * THE "ENTRE ÉTUDIANTS" SWITCH, AS THE COMPOSERS OFFER IT (owner, 2026-11-04;
 * docs/wiki/profiles-and-access.md). A post marked so is read by students and by the members of the
 * association that published it, whatever the path; the server decides it in its one visibility
 * predicate, and refuses the switch, typed ({@link STUDENTS_ONLY_NOT_OFFERED}), on a post that may
 * not carry it. Both constants equal `libs/contracts/students-only.json`, which the server's spec
 * reads too, so the offer and the refusal cannot drift apart.
 */

/** The entity types whose posts may carry the switch: an association and a list (decision 7). */
export const STUDENTS_ONLY_ASSOCIATION_TYPES: readonly string[] = ['association', 'list'];

/** The server's stable code for the switch asked for where it is not offered. */
export const STUDENTS_ONLY_NOT_OFFERED = 'students_only_not_offered';

/**
 * Whether a post published as an entity of `type` may be marked "Entre étudiants". `undefined` (a
 * personal post, or a server older than the served `type`) is never offered.
 */
export function studentsOnlyOffered(type: string | null | undefined): boolean {
  const offered = !!type && STUDENTS_ONLY_ASSOCIATION_TYPES.includes(type);
  Log.d('STUDENTS_ONLY', `offered for type ${type ?? 'none'}: ${offered}`);
  return offered;
}
