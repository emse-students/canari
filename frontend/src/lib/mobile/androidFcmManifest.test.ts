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
 * compilation - ces tests la font échouer en CI.
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

  it("déclare le service FCM avec l'intent-filter MESSAGING_EVENT", () => {
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

  it('déclare le receiver de boot (WP-XP-4) avec BOOT_COMPLETED + MY_PACKAGE_REPLACED', () => {
    // Sans lui, un token FCM qui a tourné pendant que le téléphone était éteint reste
    // mort côté serveur jusqu'à ouverture manuelle de l'app.
    expect(manifest).toContain('android.permission.RECEIVE_BOOT_COMPLETED');
    const receiverBlocks = manifest.match(/<receiver\b[\s\S]*?<\/receiver>/g) ?? [];
    const bootReceiver = receiverBlocks.find((b) => b.includes('.CanariBootReceiver'));
    expect(bootReceiver, 'receiver CanariBootReceiver absent du manifest').toBeDefined();
    expect(bootReceiver).toContain('android.intent.action.BOOT_COMPLETED');
    expect(bootReceiver).toContain('android.intent.action.MY_PACKAGE_REPLACED');
  });

  it('déclare le receiver des quick actions (WP-XP-1)', () => {
    expect(manifest).toMatch(/android:name=["']\.CanariNotificationActionReceiver["']/);
  });

  it("demande USE_FULL_SCREEN_INTENT pour la sonnerie d'appel (WP-XP-5)", () => {
    // Sans elle, la notification CallStyle ne peut pas s'afficher plein écran sur un
    // téléphone verrouillé - l'appel entrant devient une simple bannière silencieuse.
    expect(manifest).toContain('android.permission.USE_FULL_SCREEN_INTENT');
    // Et le service Kotlin doit bien exposer les deux canaux WP-XP-5.
    expect(fcmServiceKt).toMatch(/CHANNEL_CALLS\s*=\s*"canari_calls"/);
    expect(fcmServiceKt).toMatch(/CHANNEL_MENTIONS\s*=\s*"canari_mentions"/);
  });

  it('ne réintroduit pas android:debuggable avec placeholder (casse le merge release)', () => {
    // build.gradle.kts ne définit pas manifestPlaceholders["debuggable"] → un
    // android:debuggable="${debuggable}" fait échouer processUniversalReleaseMainManifest.
    // (On cible l'attribut, pas la chaîne - qui peut légitimement figurer en commentaire.)
    expect(manifest).not.toMatch(/android:debuggable\s*=\s*["']\$\{debuggable\}["']/);
  });

  it('garde allowBackup=false protégé par tools:replace (conflit merge librairies)', () => {
    expect(manifest).toMatch(/android:allowBackup=["']false["']/);
    expect(manifest).toMatch(/tools:replace=["'][^"']*android:allowBackup/);
  });
});
