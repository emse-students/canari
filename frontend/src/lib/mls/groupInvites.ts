import { apiFetch } from '$lib/utils/apiFetch';
import { deliveryUrl } from '$lib/utils/apiUrl';

/** Shareable invite links for MLS group chats (server only queues a pending add; members do the crypto). */

export interface GroupInvitePreview {
  valid: boolean;
  groupId: string | null;
  groupName: string | null;
}

/** Creates a shareable invite-link token for a group (caller must be a member). */
export async function createGroupInvite(
  groupId: string,
  opts?: { expiresAt?: string | null; maxUses?: number | null }
): Promise<{ token: string }> {
  const res = await apiFetch(
    `${deliveryUrl()}/api/mls/groups/${encodeURIComponent(groupId)}/invites`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts ?? {}),
    }
  );
  if (!res.ok) throw new Error(`Création du lien échouée (${res.status})`);
  return res.json() as Promise<{ token: string }>;
}

/** Previews a group invite (group name) before joining. */
export async function getGroupInvitePreview(token: string): Promise<GroupInvitePreview> {
  const res = await apiFetch(`${deliveryUrl()}/api/mls/group-invites/${encodeURIComponent(token)}`);
  if (!res.ok) throw new Error(`Invitation introuvable (${res.status})`);
  return res.json() as Promise<GroupInvitePreview>;
}

/**
 * Accepts a group invite. The server queues a pending membership; an online member
 * adds the user (Add + Welcome) shortly after, and the conversation then appears.
 */
export async function acceptGroupInvite(
  token: string
): Promise<{ groupId: string; alreadyMember: boolean }> {
  const res = await apiFetch(
    `${deliveryUrl()}/api/mls/group-invites/${encodeURIComponent(token)}/accept`,
    { method: 'POST' }
  );
  if (!res.ok) {
    let msg = `Impossible de rejoindre (${res.status})`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) msg = body.message;
    } catch {
      /* keep default */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<{ groupId: string; alreadyMember: boolean }>;
}
