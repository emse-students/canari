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

/** The kinds the server knows. A new kind is added here AND in the backend's `PROPOSAL_KINDS`. */
export type ProposalKind = 'repost' | 'coorganise';

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

interface ProposalBase {
  id: string;
  status: ProposalStatus;
  /** What is proposed - a post id for `repost`, an event id for `coorganise`. */
  subjectId: string;
  from: ProposalAssociation;
  to: ProposalAssociation;
  createdAt: string;
}

/**
 * One proposal in a queue, its subject typed by its kind. `subject` is null when the subject is gone
 * (a deleted post).
 */
export type Proposal =
  | (ProposalBase & { kind: 'repost'; subject: RepostSubject | null })
  | (ProposalBase & { kind: 'coorganise'; subject: CoorganiseSubject | null });

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
