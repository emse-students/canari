import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHANNEL_CALLS,
  CHANNEL_MESSAGES,
  NOTIFICATION_ICON,
} from '$lib/composables/useNotifications.svelte';

/**
 * THE WEBVIEW HALF OF THE NOTIFICATION PATH, WHICH NO ANDROID TEST RUNS HERE.
 *
 * A notification posted from the WebView goes through `tauri-plugin-notification`, not through
 * `CanariFirebaseMessagingService`, and the plugin's defaults are not ours:
 *
 *   - `TauriNotificationManager.getDefaultSmallIcon` falls back to `android.R.drawable.ic_dialog_info`
 *     unless the plugin config names a drawable. On a Mi 9T (2026-09-07) the live record read
 *     `icon=Icon(typ=RESOURCE pkg=fr.emse.canari id=0x0108009b)`, and `0x0108009b` is that framework
 *     glyph - the user saw a generic "info" badge where the Canari logo belongs.
 *   - `DEFAULT_NOTIFICATION_CHANNEL_ID = "default"` creates a sixth channel beside the five
 *     `CanariApplication.ensureChannels` designs, at IMPORTANCE_DEFAULT with no sound and no
 *     vibration, governed by none of the per-channel controls the app offers.
 *
 * Both halves are configuration, so both are invisible to `bun run check` and to every gate in this
 * repository - and the Android unit tests do not run here at all. These assertions are what make
 * them fail in CI instead of on a phone.
 *
 * A WRONG CHANNEL ID IS NOT COSMETIC: `NotificationManagerCompat` drops a notification whose channel
 * does not exist, so the third test compares the ids the TypeScript sends against the Kotlin
 * constants `ensureChannels` actually creates, rather than trusting two copies to stay equal.
 */
const here = dirname(fileURLToPath(import.meta.url));
const TAURI = resolve(here, '../../../src-tauri');
const ANDROID_MAIN = resolve(TAURI, 'gen/android/app/src/main');

const tauriConf = JSON.parse(readFileSync(resolve(TAURI, 'tauri.conf.json'), 'utf8')) as {
  plugins?: Record<string, unknown>;
};
const fcmServiceKt = readFileSync(
  resolve(ANDROID_MAIN, 'java/fr/emse/canari/CanariFirebaseMessagingService.kt'),
  'utf8'
);
const applicationKt = readFileSync(
  resolve(ANDROID_MAIN, 'java/fr/emse/canari/CanariApplication.kt'),
  'utf8'
);

/** The five density buckets a raster notification icon has to cover to render on every phone. */
const DENSITIES = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];

describe('notifications posted from the WebView (anti-régression)', () => {
  it("tauri.conf.json ne declare AUCUNE config notification, sinon l'app abandonne au demarrage", () => {
    // NOT A STYLE RULE - A CRASH. tauri-plugin-notification 2.3.3 declares `init` with no config
    // generic, so Tauri infers `()` and any object here aborts plugin initialisation:
    // PluginInitialization("notification", "... invalid type: map, expected unit"). Measured on a
    // Mi 9T: the app built, installed, and then died with SIGABRT on every single launch.
    expect(tauriConf.plugins, 'plugins absent: tauri.conf.json a change de forme').toBeDefined();
    expect(
      'notification' in (tauriConf.plugins ?? {}),
      "plugins.notification present: cette cle fait planter l'app au demarrage - l'icone passe par NOTIFICATION_ICON"
    ).toBe(false);
  });

  it('le helper obligatoire porte bien cet icone, pas seulement la constante', () => {
    // The constant existing proves nothing: what matters is that every notification carries it.
    const composable = readFileSync(
      resolve(here, '../composables/useNotifications.svelte.ts'),
      'utf8'
    );
    expect(NOTIFICATION_ICON, 'aucun nom de drawable exporte').toBeTruthy();
    const helper = composable.match(/function androidNotificationOptions\([\s\S]*?\n {2}\}/)?.[0];
    expect(
      helper,
      'androidNotificationOptions introuvable: le helper a change de nom'
    ).toBeDefined();
    expect(helper).toContain('icon: NOTIFICATION_ICON');
  });

  it('le drawable que le code nomme existe à toutes les densités', () => {
    // Reading the name back from the exported constant rather than repeating it is what makes this
    // catch a name pointing at a drawable nobody shipped - `getIdentifier` resolves that to 0 and
    // the plugin falls back to the framework glyph exactly as if no name had been given.
    const missing = DENSITIES.filter(
      (d) => !existsSync(resolve(ANDROID_MAIN, `res/drawable-${d}/${NOTIFICATION_ICON}.png`))
    );
    expect(missing, `${NOTIFICATION_ICON}.png manquant en ${missing.join(', ')}`).toEqual([]);
  });

  it('les canaux envoyés par le TypeScript sont ceux que le Kotlin crée', () => {
    const ktMessages = fcmServiceKt.match(/CHANNEL_MESSAGES\s*=\s*"([^"]+)"/)?.[1];
    const ktCalls = fcmServiceKt.match(/CHANNEL_CALLS\s*=\s*"([^"]+)"/)?.[1];
    expect(ktMessages, 'CHANNEL_MESSAGES introuvable dans le Kotlin').toBeDefined();
    expect(ktCalls, 'CHANNEL_CALLS introuvable dans le Kotlin').toBeDefined();
    expect(CHANNEL_MESSAGES).toBe(ktMessages);
    expect(CHANNEL_CALLS).toBe(ktCalls);
  });

  it('ensureChannels crée bien ces deux canaux, et tourne dans Application.onCreate', () => {
    for (const name of ['CHANNEL_MESSAGES', 'CHANNEL_CALLS']) {
      expect(
        applicationKt.includes(`CanariFirebaseMessagingService.${name}`),
        `ensureChannels ne crée pas ${name}: une notif nommant ce canal serait jetée`
      ).toBe(true);
    }
    // onCreate is what guarantees the channels exist before the WebView can post anything.
    const onCreate = applicationKt.match(/override fun onCreate\(\)[\s\S]*?\n {4}\}/)?.[0] ?? '';
    expect(onCreate, 'onCreate introuvable dans CanariApplication').not.toBe('');
    expect(onCreate).toContain('createNotificationChannels()');
  });

  it('aucun appel à sendNotification ne contourne le helper', () => {
    const composable = readFileSync(
      resolve(here, '../composables/useNotifications.svelte.ts'),
      'utf8'
    );
    const calls = composable.match(/sendNotification\(\{[\s\S]*?\n {10}\}\)/g) ?? [];
    expect(
      calls.length,
      'aucun appel à sendNotification trouvé: le motif a changé'
    ).toBeGreaterThan(1);
    for (const call of calls) {
      expect(call, `un sendNotification ne nomme pas de canal:\n${call}`).toContain(
        'androidNotificationOptions('
      );
    }
  });
});
