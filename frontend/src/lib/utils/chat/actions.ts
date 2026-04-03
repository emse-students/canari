import { exportBackup, importBackup } from '$lib/backup';
import { fromHex, toHex } from '$lib/utils/hex';
import type { IStorage } from '$lib/db';
import type { IMlsService } from '$lib/mlsService';
import type { Conversation } from '$lib/types';

function parseDirectPeerFromName(rawName: string, userId: string): string | null {
  const parts = rawName
    .split('::')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length < 2) return null;

  const current = userId.toLowerCase();
  const unique = [...new Set(parts)];
  const peer = unique.find((p) => p !== current);
  return peer ?? null;
}

/**
 * Synchronise les propres appareils de l'utilisateur courant dans tous les groupes.
 *
 * Principe MLS fondamental : seul un appareil qui POSSÈDE l'état MLS d'un groupe
 * peut inviter un nouvel appareil. Pour éviter les divergences d'epoch (deux
 * appareils différents qui font chacun un addMember indépendant au même epoch),
 * SEULS les appareils du même utilisateur ajoutent les appareils de cet utilisateur.
 *
 * Un pair (autre utilisateur) n'ajoute JAMAIS les appareils d'un autre user.
 * Chaque user gère ses propres devices via cette fonction.
 */
export async function syncOwnDevicesToGroups(params: {
  mlsService: IMlsService;
  userId: string;
  pin: string;
  conversations: Map<string, Conversation>;
  log: (msg: string) => void;
}) {
  const { mlsService, userId, pin, conversations, log } = params;

  // ── 1. Récupérer les appareils distants de l'utilisateur courant ──────
  let remoteDevices: { keyPackage: Uint8Array; deviceId: string }[];
  try {
    remoteDevices = (await mlsService.fetchUserDevices(userId)).filter(
      (d) => d.deviceId !== mlsService.getDeviceId()
    );
  } catch (e) {
    log(`[SYNC] Erreur recuperation appareils: ${e}`);
    return;
  }

  log(
    `[SYNC] Appareils distants: ${remoteDevices.length} (${remoteDevices.map((d) => d.deviceId).join(', ')})`
  );

  // ── 2. Auto-enregistrement : s'assurer que cet appareil est membre serveur ─
  const readyConvos = [...conversations.entries()].filter(([, c]) => c.isReady);
  const selfRegKey = `self_registered:${userId}:${mlsService.getDeviceId()}`;
  if (!localStorage.getItem(selfRegKey) && readyConvos.length > 0) {
    for (const [, convo] of readyConvos) {
      try {
        await mlsService.registerMember(convo.groupId, userId, mlsService.getDeviceId());
      } catch {
        /* ignore */
      }
    }
    localStorage.setItem(selfRegKey, '1');
  }

  if (remoteDevices.length === 0) return;

  // ── 3. Filtrer les appareils déjà connus (cache local) ────────────────
  const cacheKey = `known_own_devices:${userId}`;
  let knownIds: Set<string>;
  try {
    knownIds = new Set(JSON.parse(localStorage.getItem(cacheKey) ?? '[]'));
  } catch {
    knownIds = new Set();
  }

  const newDevices = remoteDevices.filter((d) => !knownIds.has(d.deviceId));
  if (newDevices.length === 0) return;

  log(`[SYNC] Nouveaux appareils: ${newDevices.map((d) => d.deviceId).join(', ')}`);

  if (readyConvos.length === 0 && conversations.size > 0) {
    log(`[SYNC] Aucune conversation prete — les appareils seront synchronises au prochain cycle.`);
    return;
  }

  // ── 4. Pour chaque appareil, l'ajouter à chaque groupe ────────────────
  // Séquentiel par appareil pour éviter les races d'epoch entre appareils.
  // Pour chaque appareil, on traite tous les groupes puis on attend la propagation.
  let totalWelcomes = 0;

  for (const device of newDevices) {
    let deviceWelcomes = 0;
    let allSucceeded = true;

    // Rafraîchir le KeyPackage (l'appareil peut en avoir publié un nouveau)
    let freshKp = device.keyPackage;
    try {
      const freshDevices = await mlsService.fetchUserDevices(userId);
      const found = freshDevices.find((d) => d.deviceId === device.deviceId);
      if (found) freshKp = found.keyPackage;
    } catch {
      /* utiliser l'ancien */
    }

    for (const [, convo] of readyConvos) {
      // Vérifier si l'appareil est déjà membre serveur de ce groupe
      try {
        const members = await mlsService.getGroupMembers(convo.groupId);
        if (members.some((m) => m.deviceId === device.deviceId)) continue;
      } catch {
        /* en cas d'erreur, tenter l'ajout quand même */
      }

      // Acquérir le verrou distribué pour ce groupe.
      // Si un autre appareil est en train d'ajouter des membres, on saute ce groupe
      // pour éviter deux commits concurrents sur le même epoch (race condition d'epoch).
      const lockAcquired = await mlsService.acquireAddLock(convo.groupId, 12_000).catch(() => true);
      if (!lockAcquired) {
        log(`[SYNC] Verrou groupe ${convo.groupId} tenu par un autre appareil — skip`);
        continue;
      }

      try {
        const result = await mlsService.addMember(convo.groupId, freshKp);
        await mlsService.registerMember(convo.groupId, userId, device.deviceId);

        if (result.welcome) {
          await mlsService.sendWelcome(
            result.welcome,
            userId,
            convo.groupId,
            device.deviceId,
            result.ratchetTree
          );
          deviceWelcomes++;
          log(`[SYNC] Welcome → ${device.deviceId} pour ${convo.groupId}`);
        } else {
          log(`[SYNC][WARN] Aucun Welcome retourne pour ${device.deviceId} dans ${convo.groupId}`);
        }

        // Sauvegarder l'état MLS AVANT sendCommit (crash-safety)
        const stBytes = await mlsService.saveState(pin);
        localStorage.setItem('mls_autosave_' + userId, toHex(stBytes));

        if (result.commit) {
          await mlsService.sendCommit(result.commit, convo.groupId);
        }

        // Court délai pour laisser le commit se propager
        await new Promise((r) => setTimeout(r, 100));
      } catch (e) {
        const errStr = String(e);
        if (errStr.includes('DuplicateSignatur') || errStr.includes('already')) {
          // L'appareil est déjà dans l'arbre MLS — s'assurer qu'il est aussi enregistré serveur
          log(`[SYNC] ${device.deviceId} deja dans l'arbre MLS de ${convo.groupId}`);
          try {
            await mlsService.registerMember(convo.groupId, userId, device.deviceId);
          } catch {
            /* ignore */
          }
        } else {
          log(`[SYNC] Erreur ajout ${device.deviceId} à ${convo.groupId}: ${errStr.slice(0, 100)}`);
          allSucceeded = false;
        }
      } finally {
        // Libérer le verrou distribué dans tous les cas (succès ou erreur)
        await mlsService.releaseAddLock(convo.groupId).catch(() => {});
      }
    }

    // Attente propagation Welcome avant de traiter le prochain appareil
    if (deviceWelcomes > 0) {
      totalWelcomes += deviceWelcomes;
      log(`[SYNC] Attente propagation ${device.deviceId} (${deviceWelcomes} Welcome(s))...`);
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Marquer connu seulement si ça a marché (retry automatique sinon)
    if (allSucceeded || deviceWelcomes > 0) {
      knownIds.add(device.deviceId);
      localStorage.setItem(cacheKey, JSON.stringify([...knownIds]));
    }
  }

  if (totalWelcomes > 0) {
    log(`[OK] ${totalWelcomes} Welcome(s) envoye(s).`);
  }
}

/** Force re-sync by clearing the known devices cache */
export function forceSyncReset(userId: string, log: (msg: string) => void) {
  localStorage.removeItem(`known_own_devices:${userId}`);
  log(`[SYNC] Cache efface. Rechargez pour relancer la sync.`);
}

/**
 * Discover groups this user belongs to on the server but doesn't have locally,
 * then re-bootstrap any orphaned groups where no device has MLS state.
 *
 * Phase 1 — Create placeholders for missing groups.
 * Phase 2 — Re-bootstrap: when ALL devices lost their MLS state (state cleared,
 * new browser session, etc.), no device can produce a Welcome → deadlock.
 * We break the deadlock by having one device re-create the MLS group locally
 * and re-invite all members.
 *
 * Leader election: alphabetically first userId among group members bootstraps.
 * Fallback: after 30 s without Welcome, any device can bootstrap.
 */
export async function discoverMissingGroups(params: {
  mlsService: IMlsService;
  userId: string;
  pin: string;
  conversations: Map<string, Conversation>;
  saveConversation?: (key: string) => Promise<void>;
  log: (msg: string) => void;
}) {
  const { mlsService, userId, pin, conversations, saveConversation, log } = params;

  // ── Phase 1: Create placeholders for server groups not present locally ────

  let serverGroups: { groupId: string; name: string; isGroup: boolean }[] = [];
  try {
    serverGroups = await mlsService.getUserGroups(userId);
  } catch {
    // Continue to Phase 2 even if server fetch fails — there may be pending placeholders
  }

  // Some backends can transiently return duplicates; keep first occurrence by groupId.
  const uniqueServerGroups = Array.from(new Map(serverGroups.map((g) => [g.groupId, g])).values());

  // Include both ready and placeholder conversations to avoid recreating
  // the same pending entry on each login.
  const localGroupIds = new Set([...conversations.values()].map((c) => c.groupId));
  const missing = uniqueServerGroups.filter((g) => !localGroupIds.has(g.groupId));

  if (missing.length > 0) {
    log(
      `[DISCOVERY] ${missing.length} groupe(s) serveur absent(s) localement: ${missing.map((g) => g.name || g.groupId).join(', ')}`
    );
  }

  for (const g of missing) {
    const existingEntry = [...conversations.entries()].find(([, c]) => c.groupId === g.groupId);
    if (existingEntry) continue;

    const directPeer = !g.isGroup ? parseDirectPeerFromName(g.name || '', userId) : null;
    const displayName = directPeer || g.name || g.groupId;

    const key = g.isGroup ? `grp_${crypto.randomUUID()}` : `dm_${crypto.randomUUID()}`;
    conversations.set(key, {
      contactName: displayName,
      name: displayName,
      groupId: g.groupId,
      messages: [],
      isReady: false, // Not ready until Welcome is processed
      mlsStateHex: null,
      conversationType: g.isGroup ? 'group' : 'direct',
      ...(directPeer ? { directPeerId: directPeer } : {}),
    });
    if (saveConversation) {
      try {
        await saveConversation(key);
      } catch (e) {
        log(
          `[WARN] Echec persistance placeholder ${g.groupId}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    log(`[DISCOVERY] Placeholder "${displayName}" créé.`);
  }

  // ── Phase 2: Re-bootstrap orphaned groups ─────────────────────────────────

  const pendingConvos = [...conversations.entries()].filter(([, c]) => !c.isReady);
  if (pendingConvos.length === 0) return;

  // Groupes déjà présents dans l'état MLS en mémoire (chargés depuis localStorage).
  // Si le groupe existe ici, l'état cryptographique est intact — un re-bootstrap
  // le détruirait et créerait un split-brain (AeadError permanent).
  const localMlsGroupIds = new Set(mlsService.getLocalGroups());

  for (const [key, convo] of pendingConvos) {
    // ── Fast path : l'état MLS existe déjà (ex: nouvel onglet ayant chargé le state) ──
    if (localMlsGroupIds.has(convo.groupId)) {
      log(
        `[DISCOVERY] "${convo.name}": etat MLS present localement — activation sans re-bootstrap.`
      );
      // S'enregistrer auprès du gateway pour que les futurs messages soient routés ici
      try {
        await mlsService.registerMember(convo.groupId, userId, mlsService.getDeviceId());
      } catch {
        /* non-blocking */
      }
      conversations.set(key, { ...convo, isReady: true });
      if (saveConversation) await saveConversation(key);
      localStorage.removeItem(`discovery_pending:${convo.groupId}`);
      continue;
    }

    let members: { userId: string }[];
    try {
      members = await mlsService.getGroupMembers(convo.groupId);
    } catch {
      continue;
    }
    if (members.length === 0) {
      log(`[DISCOVERY] "${convo.name}": aucun membre serveur — skip.`);
      continue;
    }

    const memberUserIds = [...new Set(members.map((m) => m.userId.toLowerCase()))].sort();
    const isLeader = memberUserIds[0] === userId.toLowerCase();
    const otherMemberIds = memberUserIds.filter((m) => m !== userId.toLowerCase());

    // Track how long this placeholder has been pending
    const pendingKey = `discovery_pending:${convo.groupId}`;
    const pendingSince = parseInt(localStorage.getItem(pendingKey) ?? '0', 10);
    if (!pendingSince) {
      localStorage.setItem(pendingKey, String(Date.now()));
    }
    const waitingMs = pendingSince ? Date.now() - pendingSince : 0;

    // Check if any of our OWN other devices are published.
    // If so, one of them should add us via syncOwnDevicesToGroups (triggered by
    // our sync_request). Re-bootstrapping while they have a valid MLS state would
    // create a split-brain (incompatible key material → permanent AeadError).
    let hasOtherOwnDevices = false;
    try {
      const ownDevices = await mlsService.fetchUserDevices(userId);
      hasOtherOwnDevices = ownDevices.some((d) => d.deviceId !== mlsService.getDeviceId());
    } catch {
      // ignore
    }

    let otherMemberIsActive = false;
    if (!hasOtherOwnDevices) {
      // Only check other members when we have no own devices that can send us a Welcome.
      for (const memberId of otherMemberIds) {
        try {
          const devices = await mlsService.fetchUserDevices(memberId);
          if (devices.length > 0) {
            otherMemberIsActive = true;
            break;
          }
        } catch {
          // ignore
        }
      }
    }

    // Decision logic:
    // 1. Own devices exist → ALWAYS wait for Welcome (they handle sync via sync_request)
    // 2. No own devices, other members active → they can't add us (single-writer),
    //    but leader can re-bootstrap; non-leader waits 120s
    // 3. No own devices, nobody active → truly orphaned; leader bootstraps, others wait 30s
    let shouldBootstrap: boolean;
    if (hasOtherOwnDevices) {
      // Only re-bootstrap as extreme fallback if Welcome never arrives
      shouldBootstrap = waitingMs > 120_000;
    } else if (otherMemberIsActive) {
      shouldBootstrap = isLeader || waitingMs > 120_000;
    } else {
      shouldBootstrap = isLeader || waitingMs > 30_000;
    }

    if (!shouldBootstrap) {
      log(
        hasOtherOwnDevices
          ? `[DISCOVERY] "${convo.name}": autre(s) appareil(s) propre(s) detecte(s), attente Welcome via sync_request... (${Math.round(waitingMs / 1000)}s / 120s)`
          : otherMemberIsActive
            ? `[DISCOVERY] "${convo.name}": ${otherMemberIds[0] ?? 'membre'} actif, attente re-invitation... (${Math.round(waitingMs / 1000)}s / 120s)`
            : `[DISCOVERY] "${convo.name}": attente bootstrap par ${memberUserIds[0]} (${Math.round(waitingMs / 1000)}s / 30s)`
      );
      continue;
    }

    log(
      `[DISCOVERY] Re-bootstrap "${convo.name}" (${isLeader ? 'leader' : `fallback ${Math.round(waitingMs / 1000)}s`})...`
    );

    try {
      // Create MLS group locally with the existing server groupId
      await mlsService.createGroup(convo.groupId);
      await mlsService.registerMember(convo.groupId, userId, mlsService.getDeviceId());

      // Collect all members' current devices
      const allDevices: { keyPackage: Uint8Array; deviceId: string }[] = [];
      const deviceUserMap = new Map<string, string>();
      for (const memberId of memberUserIds) {
        try {
          const devices = await mlsService.fetchUserDevices(memberId);
          for (const d of devices) {
            if (d.deviceId === mlsService.getDeviceId()) continue;
            allDevices.push(d);
            deviceUserMap.set(d.deviceId, memberId);
          }
        } catch {
          log(`[DISCOVERY] Appareils indisponibles pour ${memberId}.`);
        }
      }

      if (allDevices.length > 0) {
        const bulk = await mlsService.addMembersBulk(convo.groupId, allDevices);

        for (const did of bulk.addedDeviceIds) {
          const memberUserId = deviceUserMap.get(did);
          if (memberUserId) {
            await mlsService.registerMember(convo.groupId, memberUserId, did);
          }
        }

        if (bulk.welcome) {
          for (const did of bulk.addedDeviceIds) {
            const memberUserId = deviceUserMap.get(did);
            if (memberUserId) {
              try {
                await mlsService.sendWelcome(
                  bulk.welcome,
                  memberUserId,
                  convo.groupId,
                  did,
                  bulk.ratchetTree
                );
              } catch (e) {
                log(
                  `[DISCOVERY] Welcome echoue ${memberUserId}:${did}: ${e instanceof Error ? e.message : String(e)}`
                );
              }
            }
          }
        }

        // Sauvegarder l'état MLS AVANT sendCommit (crash-safety)
        const stBytes = await mlsService.saveState(pin);
        localStorage.setItem('mls_autosave_' + userId, toHex(stBytes));

        if (bulk.commit) {
          await mlsService.sendCommit(bulk.commit, convo.groupId);
        }
      }

      conversations.set(key, { ...convo, isReady: true });
      if (saveConversation) await saveConversation(key);
      localStorage.removeItem(pendingKey);

      log(
        `[DISCOVERY][OK] "${convo.name}" re-bootstrap (${allDevices.length} appareil(s) invite(s)).`
      );
    } catch (e) {
      log(
        `[DISCOVERY] Echec re-bootstrap "${convo.name}": ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
}

export async function exportUserBackup(params: {
  storage: IStorage;
  userId: string;
  pin: string;
  myDeviceId: string;
  log: (msg: string) => void;
}) {
  const { storage, userId, pin, myDeviceId, log } = params;
  const mlsStateHex = localStorage.getItem('mls_autosave_' + userId) ?? undefined;
  const blob = await exportBackup(storage, userId, pin, myDeviceId, mlsStateHex);
  const date = new Date().toISOString().split('T')[0];
  const filename = `canari-backup-${userId}-${date}.canari`;

  const url = URL.createObjectURL(
    new Blob([blob.buffer as ArrayBuffer], { type: 'application/octet-stream' })
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  log(`[OK] Sauvegarde exportee : ${filename}`);
}

export async function importUserBackup(params: {
  file: File;
  pin: string;
  storage: IStorage;
  myDeviceId: string;
  userId: string;
  log: (msg: string) => void;
  reloadConversations: () => Promise<void>;
  clearConversations: () => void;
}) {
  const { file, pin, storage, myDeviceId, userId, log, reloadConversations, clearConversations } =
    params;

  const arrayBuffer = await file.arrayBuffer();
  const { data: backup, isSameDevice } = await importBackup(
    new Uint8Array(arrayBuffer),
    pin,
    storage,
    myDeviceId
  );

  if (isSameDevice) {
    const existingMlsState = localStorage.getItem('mls_autosave_' + userId);
    if (backup.mlsState && !existingMlsState) {
      localStorage.setItem('mls_autosave_' + userId, backup.mlsState);
      log('État MLS restauré (même appareil).');
    } else if (existingMlsState) {
      log('État MLS local conservé (appareil déjà actif).');
    }
  } else {
    log(
      '[ATTENTION] Nouvel appareil detecte. Les conversations sont importees en lecture seule. ' +
        "Reconnectez l'appareil exportateur pour declencher l'invitation automatique aux groupes."
    );
  }

  clearConversations();
  await reloadConversations();

  log(
    `[OK] Sauvegarde importee : ${backup.conversations.length} conversation(s), ` +
      `${backup.messages.length} message(s).`
  );
}

export async function generateDevKeyPackage(params: { mlsService: IMlsService; pin: string }) {
  const { mlsService, pin } = params;
  const bytes = await mlsService.generateKeyPackage(pin);
  return toHex(bytes);
}

export async function addDevMember(params: {
  mlsService: IMlsService;
  groupId: string;
  incomingBytesHex: string;
}) {
  const { mlsService, groupId, incomingBytesHex } = params;
  const result = await mlsService.addMember(groupId, fromHex(incomingBytesHex));
  return {
    commitHex: toHex(result.commit),
    welcomeHex: result.welcome ? toHex(result.welcome) : '',
  };
}

export async function processDevWelcome(params: {
  mlsService: IMlsService;
  incomingBytesHex: string;
}) {
  const { mlsService, incomingBytesHex } = params;
  await mlsService.processWelcome(fromHex(incomingBytesHex));
}
