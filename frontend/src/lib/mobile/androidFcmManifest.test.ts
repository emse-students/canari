import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Garde-fou anti-régression FCM.
 *
 * Tauri régénère parfois AndroidManifest.xml (ex. `tauri android init`) et écrase
 * les déclarations custom. Sans le <service> CanariFirebaseMessagingService lié à
 * l'intent-filter `com.google.firebase.MESSAGING_EVENT`, Firebase n'appelle jamais
 * onMessageReceived : les push partent du serveur mais aucune notification n'apparaît
 * quand l'app est tuée. Cette régression (commit 53e659a0) est invisible à la
 * compilation — ces tests la font échouer en CI.
 */
const here = dirname(fileURLToPath(import.meta.url));
const ANDROID_MAIN = resolve(here, '../../../src-tauri/gen/android/app/src/main');

const manifest = readFileSync(resolve(ANDROID_MAIN, 'AndroidManifest.xml'), 'utf8');
const fcmServiceKt = readFileSync(
  resolve(ANDROID_MAIN, 'java/fr/emse/canari/CanariFirebaseMessagingService.kt'),
  'utf8'
);

describe('AndroidManifest FCM registration (anti-régression)', () => {
  it('enregistre la classe Application custom (.CanariApplication)', () => {
    expect(manifest).toMatch(/android:name=["']\.CanariApplication["']/);
  });

  it('déclare le service FCM avec l’intent-filter MESSAGING_EVENT', () => {
    const serviceBlock = manifest.match(/<service\b[\s\S]*?<\/service>/g) ?? [];
    const fcmService = serviceBlock.find((b) => b.includes('.CanariFirebaseMessagingService'));
    expect(fcmService, 'service CanariFirebaseMessagingService absent du manifest').toBeDefined();
    expect(fcmService).toContain('com.google.firebase.MESSAGING_EVENT');
  });

  it('demande la permission POST_NOTIFICATIONS (Android 13+)', () => {
    expect(manifest).toContain('android.permission.POST_NOTIFICATIONS');
  });

  it('le canal de notif par défaut du manifest correspond à CHANNEL_MESSAGES du service Kotlin', () => {
    const ktChannel = fcmServiceKt.match(/CHANNEL_MESSAGES\s*=\s*"([^"]+)"/)?.[1];
    expect(ktChannel, 'const CHANNEL_MESSAGES introuvable dans le service Kotlin').toBeTruthy();

    const manifestChannel = manifest.match(
      /default_notification_channel_id["'][\s\S]*?android:value=["']([^"']+)["']/
    )?.[1];
    expect(
      manifestChannel,
      'meta-data default_notification_channel_id absente du manifest'
    ).toBeTruthy();

    expect(manifestChannel).toBe(ktChannel);
  });
});
