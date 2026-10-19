/**
 * PROPOSALS BETWEEN ASSOCIATIONS - the generic queue (D38), read and decided on an association's
 * management page.
 *
 * One association proposes something to another, whose holders of the kind's flag accept or refuse
 * it; the sender may withdraw it while it waits. `repost` (a post offered for republication, D38)
 * and `coorganise` (an event offered for co-organisation, D39) share the table, the routes and this
 * file. The server owns every right: what this module offers is only what it answered.
 */
import { socialRequest } from '$lib/posts/api';

/**
 * The kinds the server knows. A new kind is added here AND in the backend's `PROPOSAL_KINDS`.
 * `repost-personal` (D38b) is the one addressed to a PERSON - the author of a personal post, who
 * alone decides it from `/notifications/requests`; an association sees it only as something it SENT.
 */
export type ProposalKind = 'repost' | 'coorganise' | 'repost-personal';

export type ProposalStatus = 'pending' | 'accepted' | 'refused' | 'withdrawn';

/** An association beside a proposal. */
export interface ProposalAssociation {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
}

/** A `repost` proposal's subject, as its handler describes it. */
export interface RepostSubject {
  /** The post's opening, already shortened by the server. */
  preview: string;
  createdAt: string;
  associationName: string | null;
}

/** A `coorganise` proposal's subject: the event, and the association organising it. */
export interface CoorganiseSubject {
  title: string;
  startsAt: string;
  endsAt: string | null;
  associationName: string | null;
}

/** A personal post an association asked its author to let it carry (D38b). */
export interface PersonalRepostSubject {
  preview: string;
  createdAt: string;
}

/** A person beside a proposal: the author asked, or the member who asked. `name` null when unknown. */
export interface ProposalPerson {
  id: string;
  name: string | null;
}

interface ProposalBase {
  id: string;
  status: ProposalStatus;
  /** What is proposed - a post id for `repost` and `repost-personal`, an event id for `coorganise`. */
  subjectId: string;
  from: ProposalAssociation;
  createdAt: string;
}

/** Addressed to an association, whose holders of the kind's flag decide. */
interface AssociationAddressed extends ProposalBase {
  to: ProposalAssociation;
  toUser: null;
}

/** Addressed to a person (D38b), who alone decides. */
interface PersonAddressed extends ProposalBase {
  to: null;
  /** Null, with `subject` null too, when the caller may not see the post: nothing about it is told. */
  toUser: ProposalPerson | null;
}

/**
 * One proposal in a queue, its subject typed by its kind. `subject` is null when the subject is gone
 * (a deleted post).
 */
export type Proposal =
  | (AssociationAddressed & { kind: 'repost'; subject: RepostSubject | null })
  | (AssociationAddressed & { kind: 'coorganise'; subject: CoorganiseSubject | null })
  | (PersonAddressed & { kind: 'repost-personal'; subject: PersonalRepostSubject | null });

/**
 * One request in the AUTHOR's inbox (D38b): who asks, in which association's name, about which post,
 * and how many readers accepting would newly reach - so the answer is an informed one.
 */
export interface RepublicationRequest {
  id: string;
  kind: 'repost-personal';
  status: ProposalStatus;
  /** The post asked about. */
  subjectId: string;
  /** The association that would carry the post. */
  from: ProposalAssociation;
  /** The member who asked; null once their account is erased. */
  proposedBy: ProposalPerson | null;
  /** Null when the post is gone. */
  details: (PersonalRepostSubject & { newlyReached: number }) | null;
  createdAt: string;
}

/**
 * How many requests wait on the signed-in author - one count, for a page that only draws the way to
 * the inbox and must not run its per-request audience counts on every open.
 */
export async function countMyRepublicationRequests(): Promise<number> {
  const { pending } = await socialRequest<{ pending: number }>(
    '/api/posts/me/republication-requests/count'
  );
  return pending;
}

/**
 * The refusal code of an acceptance whose asker no longer speaks for the association: the request
 * was voided by the server, and the inbox says why instead of "already decided".
 */
export const PROPOSAL_SENDER_GONE = 'PROPOSAL_SENDER_GONE';

/** The requests waiting on the signed-in author, oldest first. */
export async function listMyRepublicationRequests(): Promise<{
  incoming: RepublicationRequest[];
}> {
  return socialRequest<{ incoming: RepublicationRequest[] }>(
    '/api/posts/me/republication-requests'
  );
}

/** An association's pending proposals: what it was sent, and what it sent and still waits on. */
export interface ProposalQueue {
  incoming: Proposal[];
  outgoing: Proposal[];
}

/** The pending queue of `associationId`. 403 to whoever holds no proposal flag there. */
export async function listPendingProposals(associationId: string): Promise<ProposalQueue> {
  return socialRequest<ProposalQueue>(
    `/api/associations/${encodeURIComponent(associationId)}/proposals`
  );
}

/** Accepts a proposal: the kind's effect (a republication, for `repost`) is applied with it. */
export async function acceptProposal(proposalId: string): Promise<unknown> {
  return socialRequest(`/api/associations/proposals/${proposalId}/accept`, { method: 'POST' });
}

/**
 * Refuses a proposal. The refusal is RECORDED: the same subject cannot be proposed to this
 * association again (only a withdrawn proposal frees its place).
 */
export async function refuseProposal(proposalId: string): Promise<unknown> {
  return socialRequest(`/api/associations/proposals/${proposalId}/refuse`, { method: 'POST' });
}

/** The sender withdraws a proposal still waiting. */
export async function withdrawProposal(proposalId: string): Promise<unknown> {
  return socialRequest(`/api/associations/proposals/${proposalId}/withdraw`, { method: 'POST' });
}
