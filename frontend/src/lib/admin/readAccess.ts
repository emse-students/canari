/**
 * The pure half of `/admin/read-access`: how a person's grant cells are grouped for their card,
 * and how a reviewer list is told as a journal.
 *
 * Kept out of the components so the grouping (campus order, whole campus first, formation order)
 * is ONE rule the card and its test read, and the page never re-derives it.
 */
import type { DocumentReviewerGrant, ReadGrant } from '$lib/associations/api';
import { CAMPUSES, FORMATIONS, type Campus, type Formation } from '$lib/profile/miconnectProfile';

/** One cell: a campus, and a formation or `null` for the whole campus. */
export interface ReadCell {
  campus: Campus;
  formation: Formation | null;
}

/** A cell's identity: one string per (person, campus, formation-or-whole-campus). */
export function cellKey(userId: string, campus: string, formation: string | null): string {
  return `${userId}|${campus}|${formation ?? '*'}`;
}

/** The scopes of one campus a person holds, whole campus first, then formations in their order. */
export interface CampusScopes {
  campus: Campus;
  scopes: (Formation | null)[];
}

/** Every scope of a campus, in display order: the whole campus, then each formation. */
export const CAMPUS_SCOPES: readonly (Formation | null)[] = [null, ...FORMATIONS];

/**
 * Groups ONE person's grants by campus, in `CAMPUSES` order; a campus they hold nothing on is
 * left out. A row naming an unknown campus or formation (a server ahead of this client) is dropped
 * with a log line rather than drawn as a raw value.
 */
export function groupGrantsByCampus(grants: readonly ReadGrant[]): CampusScopes[] {
  const held = new Set(grants.map((g) => `${g.campus}|${g.formation ?? '*'}`));
  for (const g of grants) {
    const knownCampus = (CAMPUSES as readonly string[]).includes(g.campus);
    const knownScope =
      g.formation === null || (FORMATIONS as readonly string[]).includes(g.formation);
    if (!knownCampus || !knownScope) {
      console.warn('[admin.read-access] grant cell unknown to this client, not drawn', {
        campus: g.campus,
        formation: g.formation,
      });
    }
  }
  return CAMPUSES.map((campus) => ({
    campus,
    scopes: CAMPUS_SCOPES.filter((scope) => held.has(`${campus}|${scope ?? '*'}`)),
  })).filter((group) => group.scopes.length > 0);
}

/**
 * The people a grant list names, in the order they first appear (the server's order), so a card
 * does not jump when one of its cells changes.
 */
export function grantees(grants: readonly ReadGrant[]): string[] {
  return [...new Set(grants.map((g) => g.userId))];
}

/** One line of the reviewers' journal: who authorized whom, and when. */
export interface ReviewerJournalLine {
  userId: string;
  actor: string;
  at: string;
}

/**
 * The reviewers' journal, newest first. The server keeps no history for this capability - only
 * the grants in force, each with its author and date - so this is all a journal can truthfully
 * say: a removal leaves no trace, and the page says so under the list.
 */
export function reviewerJournal(grants: readonly DocumentReviewerGrant[]): ReviewerJournalLine[] {
  return grants
    .map((g) => ({ userId: g.userId, actor: g.grantedBy, at: g.createdAt }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** One journal line of an access section, already worded by the caller. */
export interface JournalLine {
  /** Unique within the journal. */
  key: string;
  /** ISO date of the change. */
  at: string;
  text: string;
}
