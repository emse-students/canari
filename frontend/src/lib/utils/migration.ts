import type { IStorage } from '../db';
export async function migrateFromLocalStorage(
  userId: string,
  pin: string,
  storage: IStorage,
  log: (msg: string) => void
) {
  if (!storage) return;

  const prefix = 'canari_conv_' + userId + '_';
  const keysToMigrate: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(prefix)) keysToMigrate.push(key);
  }
  if (keysToMigrate.length === 0) return;

  log(`Migration de ${keysToMigrate.length} conversation(s) depuis localStorage…`);
  for (const key of keysToMigrate) {
    const saved = localStorage.getItem(key);
    if (!saved) continue;
    const contactName = key.substring(prefix.length);
    let data: any;
    try {
      data = JSON.parse(saved);
    } catch {
      continue;
    }

    await storage.saveConversation({
      id: contactName,
      groupId: data.groupId,
      name: data.name || contactName,
      isReady: data.isReady || false,
      updatedAt: Date.now(),
    });

    for (const m of (data.messages || []) as any[]) {
      try {
        await storage.saveMessage(
          {
            id: m.id || crypto.randomUUID(),
            conversationId: contactName,
            senderId: m.senderId || '',
            content: m.content || '',
            timestamp: m.timestamp ? new Date(m.timestamp).getTime() : Date.now(),
          },
          pin
        );
      } catch {
        // skip invalid rows
      }
    }

    localStorage.removeItem(key);
  }
  log('Migration terminée ✅');
}
