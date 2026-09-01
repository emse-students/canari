import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * FCM anti-regression guardrail.
 *
 * Tauri sometimes regenerates AndroidManifest.xml (e.g. `tauri android init`) and overwrites the
 * custom declarations. Without the <service> CanariFirebaseMessagingService bound to the
 * `com.google.firebase.MESSAGING_EVENT` intent-filter, Firebase never calls onMessageReceived:
 * pushes leave the server but no notification appears when the app is killed. This regression
 * (commit 53e659a0) is invisible at compile time - these tests make it fail in CI.
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

  it('declares the boot receiver (WP-XP-4) with BOOT_COMPLETED + MY_PACKAGE_REPLACED', () => {
    // Without it, an FCM token that rotated while the phone was off stays dead
    // server-side until the app is manually opened.
    expect(manifest).toContain('android.permission.RECEIVE_BOOT_COMPLETED');
    const receiverBlocks = manifest.match(/<receiver\b[\s\S]*?<\/receiver>/g) ?? [];
    const bootReceiver = receiverBlocks.find((b) => b.includes('.CanariBootReceiver'));
    expect(bootReceiver, 'receiver CanariBootReceiver absent du manifest').toBeDefined();
    expect(bootReceiver).toContain('android.intent.action.BOOT_COMPLETED');
    expect(bootReceiver).toContain('android.intent.action.MY_PACKAGE_REPLACED');
  });

  it('declares the quick-action receiver (WP-XP-1)', () => {
    expect(manifest).toMatch(/android:name=["']\.CanariNotificationActionReceiver["']/);
  });

  it('does NOT request USE_FULL_SCREEN_INTENT while calls are held off (CALLS_ENABLED)', () => {
    // Inverted on 2026-09-01. Play grants this permission only to calling or alarm apps, so it may
    // not be declared for a surface CALLS_ENABLED hides; this assertion is what stops a manifest
    // regeneration from quietly re-adding it. The match is on the TAG, not the string: the comment
    // that replaced it still names the permission, and a `toContain` would pass on that comment -
    // which is exactly the false green this rewrite exists to prevent.
    const permissionTags = manifest.match(/<uses-permission[^>]*\/>/g) ?? [];
    expect(permissionTags.some((t) => t.includes('USE_FULL_SCREEN_INTENT'))).toBe(false);
    // The ring CHANNELS stay declared: the Kotlin is untouched, only its entry point is gated, and
    // the channels must survive the hold so a revival needs no notification-settings migration.
    expect(fcmServiceKt).toMatch(/CHANNEL_CALLS\s*=\s*"canari_calls"/);
    expect(fcmServiceKt).toMatch(/CHANNEL_MENTIONS\s*=\s*"canari_mentions"/);
  });

  it('gates the incoming-call ring on CALLS_ENABLED (WP-XP-5, held off)', () => {
    // The permission above is the store-facing half; this is the behavioural one. A peer on an
    // older build still sends call_ring, and showIncomingCallNotification is the single choke point
    // both of its callers pass through.
    expect(fcmServiceKt).toMatch(/private const val CALLS_ENABLED = false/);
    expect(fcmServiceKt).toContain('showIncomingCallNotification: calls disabled');
  });

  it('does not reintroduce android:debuggable with placeholder (breaks release merge)', () => {
    // build.gradle.kts does not define manifestPlaceholders["debuggable"] -> an
    // android:debuggable="${debuggable}" causes processUniversalReleaseMainManifest to fail.
    // (We target the attribute, not the string - which may legitimately appear in comments.)
    expect(manifest).not.toMatch(/android:debuggable\s*=\s*["']\$\{debuggable\}["']/);
  });

  it('garde allowBackup=false protégé par tools:replace (conflit merge librairies)', () => {
    expect(manifest).toMatch(/android:allowBackup=["']false["']/);
    expect(manifest).toMatch(/tools:replace=["'][^"']*android:allowBackup/);
  });
});
