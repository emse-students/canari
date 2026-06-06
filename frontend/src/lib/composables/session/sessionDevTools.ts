/**
 * Fonctions dev-tools extraites de useChatSession :
 * addDevMemberImpl, generateDevKeyPackageImpl, processDevWelcomeImpl.
 *
 * Ces fonctions ne sont utilisées qu'en développement (panneau de debug).
 */
import { addDevMember, generateDevKeyPackage, processDevWelcome } from '$lib/utils/chat/actions';
import type { SessionContext, ChatSessionCallbacks } from './sessionTypes';

/**
 * Dev-tool: adds a member (KeyPackage from incomingBytesHex) to an MLS group
 * and stores the resulting Commit/Welcome hex for inspection.
 */
export async function addDevMemberImpl(
  ctx: SessionContext,
  cb: ChatSessionCallbacks,
  targetGroupId: string
): Promise<void> {
  if (!ctx.getIncomingBytesHex()) return;
  try {
    const result = await addDevMember({
      mlsService: ctx.ensureMls(),
      groupId: targetGroupId,
      incomingBytesHex: ctx.getIncomingBytesHex(),
    });
    ctx.setLastCommit(result.commitHex);
    if (result.welcomeHex) ctx.setLastWelcome(result.welcomeHex);
    ctx.setIncomingBytesHex('');
  } catch (_e: unknown) {
    cb.log(`Err AddMember: ${_e instanceof Error ? _e.message : String(_e)}`);
  }
}

/**
 * Dev-tool: generates a new MLS KeyPackage for this device
 * and stores it in lastKeyPackage (hex).
 */
export async function generateDevKeyPackageImpl(
  ctx: SessionContext,
  cb: ChatSessionCallbacks
): Promise<void> {
  try {
    const kp = await generateDevKeyPackage({ mlsService: ctx.ensureMls(), pin: ctx.getPin() });
    ctx.setLastKeyPackage(kp);
  } catch (_e: unknown) {
    cb.log(`Err GenKeyPackage: ${_e instanceof Error ? _e.message : String(_e)}`);
  }
}

/**
 * Dev-tool: processes a Welcome message (hex in incomingBytesHex)
 * so this device joins the corresponding MLS group.
 */
export async function processDevWelcomeImpl(
  ctx: SessionContext,
  cb: ChatSessionCallbacks
): Promise<void> {
  if (!ctx.getIncomingBytesHex()) return;
  try {
    await processDevWelcome({
      mlsService: ctx.ensureMls(),
      incomingBytesHex: ctx.getIncomingBytesHex(),
    });
    ctx.setIncomingBytesHex('');
  } catch (_e: unknown) {
    cb.log(`Err ProcessWelcome: ${_e instanceof Error ? _e.message : String(_e)}`);
  }
}
